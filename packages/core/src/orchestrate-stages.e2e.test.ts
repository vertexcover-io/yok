import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { runDirOf, type SavedPolicies, type WorkflowRun } from "@yok/sdk";
import { validateTicketDir } from "../../../skills/ticket-fetcher/scripts/ticket.ts";
import { completeContextStep } from "./runs.ts";
import {
  eventsOf,
  fileArtifact,
  initializedRun,
  orchestrate,
  orchestrateAsync,
  parseStep,
  readRegistry,
  STAGE_SKILLS,
  STAGES_WORKFLOW,
  savedRun,
  stageSkills,
  startedRun,
  tempDir,
  tempRepo,
  waitFor,
  withContext,
  writeRegistry,
} from "./test-orchestrate.ts";
import { DEMO_STAGES, writeStages } from "./workflow/test-stages.ts";

const stateOf = (repo: string) =>
  JSON.parse(readFileSync(join(runDirOf(repo, "feat-x"), "state.json"), "utf8"));

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
      const make = parseStep(step(["next", "--run", "feat-x"]).stdout);
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
      return parseStep(step(["next", "--run", "feat-x"]).stdout);
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
    expect(parseStep(next.stdout)).toEqual({ kind: "finished", status: "failed" });
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
    const reply = parseStep(next.stdout);
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

    const make = parseStep(step(["next", "--run", "feat-x"]).stdout);
    expect(make).toMatchObject({ kind: "stage", policies: { interaction: false } });

    const summary = ["--summary", "Made it.", "--output", "{}"];
    expect(step(["done", make.nodeRunId, "--run", "feat-x", ...summary]).code).toBe(0);
    const plan = parseStep(step(["next", "--run", "feat-x"]).stdout);
    expect(plan).toMatchObject({ kind: "agent", policies: { interaction: false } });

    const unsaved = startedRun(POLICED);
    const first = orchestrate(unsaved.repo, unsaved.home, ["next", "--run", "feat-x"], {
      YOK_SKILLS_DIR: STAGE_SKILLS,
    });
    expect(parseStep(first.stdout)).toMatchObject({ policies: { interaction: true } });
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
    const edit = parseStep(step(["next", "--run", "feat-x"]).stdout);
    expect(edit).toMatchObject({ nodeId: "edit", summaryHint: "Say how many files changed." });

    const summary = ["--summary", "Changed three files."];
    expect(
      step(["done", edit.nodeRunId, "--run", "feat-x", ...summary, "--output", "{}"]).code,
    ).toBe(0);
    const check = parseStep(step(["next", "--run", "feat-x"]).stdout);
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
    const reply = parseStep(step(["next", "--run", "feat-x"]).stdout);
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

  test("concurrent done calls record exactly one completion", async () => {
    const { repo, home, skills, step } = stageRun();
    const reply = parseStep(step(["next", "--run", "feat-x"]).stdout);
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
    expect(parseStep(next.stdout)).toMatchObject({
      kind: "agent",
      mode: "subagent",
      prompt: "check it",
      input: {},
    });
  });

  test("IW30 — done reads --output - and --error - from stdin, keeping quotes and $(…) as plain text", () => {
    const { repo, home, skills } = stageRun();
    const env = { YOK_SKILLS_DIR: skills };
    const next = () => parseStep(orchestrate(repo, home, ["next", "--run", "feat-x"], env).stdout);
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
    const reply = parseStep(step(["next", "--run", "feat-x"]).stdout);
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
    const make = parseStep(step(["next", "--run", "feat-x"]).stdout);
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
    expect(parseStep(step(["next", "--run", "feat-x"]).stdout)).toEqual({
      kind: "finished",
      status: "failed",
    });
    expect(stateOf(repo).nodeRuns.after).toBeUndefined();
  });

  test("SC517: with no saved policies, done --error fails an allowFailure stage as exception and next starts the following node", () => {
    const { repo, step, question } = failMake({});

    expect(stateOf(repo).nodeRuns.make.output).toEqual({ kind: "exception", message: question });
    expect(parseStep(step(["next", "--run", "feat-x"]).stdout)).toMatchObject({
      kind: "agent",
      nodeId: "after",
    });
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
    const fetcher = parseStep(step(["next", "--run", "feat-x"]).stdout);
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
    return parseStep(step(["next", "--run", "feat-x"]).stdout);
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
    const first = parseStep(orchestrate(repo, home, ["next", "--run", "feat-x"], env).stdout);

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

    const again = parseStep(orchestrate(repo, home, ["next", "--run", "feat-x"], env).stdout);
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
    const first = parseStep(orchestrate(repo, home, ["next", "--run", "feat-x"], env).stdout);
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
    const context = parseStep(orchestrate(repo, home, ["next", "--run", "feat-x"], env).stdout);
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
    const first = parseStep(orchestrate(repo, home, ["next", "--run", "feat-x"]).stdout);
    const late = orchestrateAsync(repo, home, ["exec", first.nodeRunId, "--run", "feat-x"]);
    await waitFor(() => existsSync(join(repo, "started")));
    orchestrate(repo, home, ["resume", "--run", "feat-x"]);
    const again = parseStep(orchestrate(repo, home, ["next", "--run", "feat-x"]).stdout);
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
    const first = parseStep(step(["next", "--run", "feat-x"]).stdout);
    expect(step(["exec", first.nodeRunId, "--run", "feat-x"]).code).toBe(0);
    const second = parseStep(step(["next", "--run", "feat-x"]).stdout);

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

    const again = parseStep(step(["next", "--run", "feat-x"]).stdout);
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
    const first = parseStep(orchestrate(repo, home, ["next", "--run", "feat-x"], env).stdout);
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

describe("SC26: orchestrate next notes", () => {
  const env = { YOK_SKILLS_DIR: STAGE_SKILLS };
  const COMPACT_THEN_FIX = `name: compact-then-fix
inputs:
  prompt: { type: string, required: true }
nodes:
  - { id: compact-before-fix, type: context, action: compact }
  - { id: fix, type: agent, prompt: fix it, dependsOn: [compact-before-fix], input: {} }
`;
  const nextReply = (repo: string, home: string) =>
    JSON.parse(orchestrate(repo, home, ["next", "--run", "feat-x"], env).stdout);
  const completedContext = async (output: Parameters<typeof completeContextStep>[2]) => {
    const { repo, home } = startedRun(COMPACT_THEN_FIX);
    const context = nextReply(repo, home);
    expect(context).toMatchObject({ kind: "context", nodeId: "compact-before-fix" });
    const run = { id: "r-1", cwd: repo, name: "feat-x" };
    expect((await completeContextStep(run, context.nodeRunId, output)).ok).toBe(true);
    return { repo, home };
  };

  test("SC22: the first next after a compact that did not happen carries its note and hands out fix, and the next one has no notes", async () => {
    const reason = "Claude did not take /compact after 2 tries";
    const { repo, home } = await completedContext({ action: "compact", applied: false, reason });

    const first = nextReply(repo, home);
    expect(first.notes).toEqual([`compact-before-fix was skipped: ${reason}`]);
    expect(first.steps).toMatchObject([{ nodeId: "fix" }]);
    expect(nextReply(repo, home)).not.toHaveProperty("notes");
  });

  test("SC23: a next after a compact that happened has no notes field", async () => {
    const { repo, home } = await completedContext({
      action: "compact",
      applied: true,
      sessionId: "s1",
    });

    const reply = nextReply(repo, home);
    expect(reply.steps).toMatchObject([{ nodeId: "fix" }]);
    expect(reply).not.toHaveProperty("notes");
  });
});
