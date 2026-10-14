import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ArtifactRef,
  createGit,
  type NodeRun,
  noopLogger,
  type RunRef,
  runDirOf,
  type WorkflowRun,
} from "@yok/sdk";
import { createRegistry, jsonlEventStore } from "@yok/sdk/internal";
import { finishStep, initializeRun, interruptOpenSteps, nextStep } from "../runs.ts";
import { VerifierSchema } from "../stage.ts";
import { compileWorkflow } from "./compile.ts";
import {
  type CompletionIssue,
  findConsumedArtifacts,
  findDefaultIssues,
  readOutput,
  SUMMARY_LIMIT,
  summaryIssues,
} from "./done.ts";
import { DEMO_STAGES, type DemoStage, writeStages } from "./test-stages.ts";
import type { PlanAgentNode } from "./types.ts";
import { artifactPaths, issuesOf, loadVerifiers, runVerifiers } from "./verifiers.ts";

const tempDir = (): string => realpathSync(mkdtempSync(join(tmpdir(), "yok-done-")));

const STAGES = {
  ...DEMO_STAGES,
  drafter: { produces: "[{ artifact: plan }, { artifact: notes, optional: true }]" },
  writer: { produces: "[{ artifact: plan }, { artifact: notes }]" },
};

const RESULT_SCHEMA = `import { z } from ${JSON.stringify(import.meta.resolve("zod"))};
export const schemas = { result: z.object({ ok: z.boolean() }) };
`;

// The agent node ID of a workflow whose NODES may name the demo stages under stages/ and the
// workflow.yaml schema `result` from ./schemas.ts.
const compileAgent = async (nodes: string, id: string): Promise<PlanAgentNode> => {
  const root = tempDir();
  writeStages(join(root, "stages"), STAGES);
  writeFileSync(join(root, "schemas.ts"), RESULT_SCHEMA);
  writeFileSync(join(root, "main.yml"), `name: t\nnodes:\n${nodes}`);
  const plan = await compileWorkflow(join(root, "main.yml"), { cwd: root });
  const node = plan.nodes.find((candidate) => candidate.id === id);
  if (node?.type !== "agent") throw new Error(`${id} is not an agent node`);
  return node;
};

const stageNode = (stage: string): Promise<PlanAgentNode> =>
  compileAgent(`  - { id: make, type: agent, stage: stages/${stage}, input: {} }\n`, "make");

const PLAIN = "  - { id: ask, type: agent, prompt: Make it, input: null }\n";
const SCHEMA_CHECKED =
  "  - { id: ask, type: agent, prompt: check it, input: {}, output: { module: ./schemas.ts, zodSchema: result } }\n";

// A run folder with an empty artifacts/ and the files NAMES written in it.
const runFolder = (...names: readonly string[]): string => {
  const runDir = join(tempDir(), ".yok", "feat-x");
  mkdirSync(join(runDir, "artifacts"), { recursive: true });
  for (const name of names) writeFileSync(join(runDir, "artifacts", name), `${name}\n`);
  return runDir;
};

const file = (type: string, path = `artifacts/${type}.md`, name = type): ArtifactRef => ({
  type,
  name,
  path,
});

const missingFile = (runDir: string, name: string): CompletionIssue => ({
  kind: "artifact-file",
  name,
  path: join(runDir, `artifacts/${name}.md`),
  reason: "missing",
  message: `artifact ${name}: ${join(runDir, `artifacts/${name}.md`)} does not exist`,
});

describe("summaryIssues", () => {
  test.each([
    ["no summary", undefined, "missing"],
    ["a summary on two lines", "Did it.\nAnd more.", "multi-line"],
    [`a summary over ${SUMMARY_LIMIT} characters`, "x".repeat(SUMMARY_LIMIT + 1), "too-long"],
    ["a summary that is JSON", '{"ok":true}', "not-prose"],
    ["a summary that is code", "  `rm -rf x`", "not-prose"],
  ] as const)("refuses %s, saying what a summary must be", (_label, summary, reason) => {
    expect(summaryIssues(summary)).toEqual([
      { kind: "summary", reason, message: expect.stringContaining("one plain sentence") },
    ]);
  });

  test.each([
    ["a plain sentence", "Did the work."],
    [`exactly ${SUMMARY_LIMIT} characters`, "x".repeat(SUMMARY_LIMIT)],
  ])("takes %s", (_label, summary) => {
    expect(summaryIssues(summary)).toEqual([]);
  });
});

describe("readOutput", () => {
  test.each([
    ["plain words", "all checks green"],
    ["text that looks like JSON", '{"ok":true}'],
  ])("a node with no output schema keeps its output as text: %s", async (_label, text) => {
    expect(readOutput(await compileAgent(PLAIN, "ask"), text)).toEqual({ ok: true, value: text });
  });

  test("a node with an output schema parses its output as JSON, and refuses text that is not", async () => {
    const node = await compileAgent(SCHEMA_CHECKED, "ask");

    expect(readOutput(node, '{"ok":true}')).toEqual({ ok: true, value: { ok: true } });
    expect(readOutput(node, "looks fine to me")).toEqual({
      ok: false,
      error: {
        kind: "output-schema",
        schema: "result",
        path: "",
        message: "output is not valid JSON",
      },
    });
  });
});

describe("findDefaultIssues", () => {
  test("a stage's output and artifacts that match it have no issues, nor does an artifact it never declared or a link", async () => {
    const runDir = runFolder("plan.md", "extra.md");
    const link = { type: "pull-request", name: "lydia", url: "https://github.com/o/lydia/pull/1" };
    const artifacts = [file("plan"), file("extra"), link];

    expect(await findDefaultIssues(await stageNode("producer"), {}, artifacts, runDir)).toEqual([]);
  });

  test("every required artifact left out is reported, and an optional one may be left out", async () => {
    const runDir = runFolder("plan.md");

    expect(await findDefaultIssues(await stageNode("writer"), {}, [], runDir)).toEqual([
      { kind: "required-artifact", name: "plan" },
      { kind: "required-artifact", name: "notes" },
    ]);
    expect(await findDefaultIssues(await stageNode("drafter"), {}, [file("plan")], runDir)).toEqual(
      [],
    );
  });

  test("every registered file that does not exist is reported, optional ones too", async () => {
    const runDir = runFolder();

    const issues = await findDefaultIssues(
      await stageNode("drafter"),
      {},
      [file("plan"), file("notes")],
      runDir,
    );

    expect(issues).toEqual([missingFile(runDir, "plan"), missingFile(runDir, "notes")]);
  });

  test("a file reached through a symlink out of artifacts/, or a folder, is refused", async () => {
    const runDir = runFolder();
    const outside = join(runDir, "..", "outside.md");
    writeFileSync(outside, "old plan\n");
    symlinkSync(outside, join(runDir, "artifacts", "plan.md"));
    mkdirSync(join(runDir, "artifacts", "drafts"));

    const issues = await findDefaultIssues(
      await compileAgent(PLAIN, "ask"),
      null,
      [file("plan"), file("drafts", "artifacts/drafts")],
      runDir,
    );

    expect(issues).toEqual([
      expect.objectContaining({
        name: "plan",
        reason: "outside-run",
        message: expect.stringContaining("inside artifacts/"),
      }),
      expect.objectContaining({ name: "drafts", reason: "not-file" }),
    ]);
  });

  test("an artifacts/ folder replaced by a symlink out of the run is refused whatever it holds", async () => {
    const runDir = runFolder();
    const outside = join(runDir, "..", "external");
    mkdirSync(outside);
    writeFileSync(join(outside, "plan.md"), "old plan\n");
    renameSync(join(runDir, "artifacts"), join(runDir, "artifacts-stored"));
    symlinkSync(outside, join(runDir, "artifacts"));

    expect(
      await findDefaultIssues(await stageNode("producer"), {}, [file("plan")], runDir),
    ).toEqual([
      {
        kind: "artifact-file",
        name: "artifacts",
        path: join(runDir, "artifacts"),
        reason: "invalid-artifacts-dir",
        message: `run artifacts/ must be a real directory inside ${runDir}`,
      },
    ]);
  });

  test("the same type and name registered twice is refused once per repeat", async () => {
    const runDir = runFolder("first.md", "second.md");
    const notes = [file("note", "artifacts/first.md"), file("note", "artifacts/second.md")];

    expect(await findDefaultIssues(await compileAgent(PLAIN, "ask"), null, notes, runDir)).toEqual([
      { kind: "artifact-name", type: "note", name: "note", reason: "duplicate" },
    ]);
  });

  test("output that fails the stage's schema is reported after the artifact issues", async () => {
    const issues = await findDefaultIssues(await stageNode("producer"), [], [], runFolder());

    expect(issues).toEqual([
      { kind: "required-artifact", name: "plan" },
      expect.objectContaining({ kind: "output-schema", schema: "demo.output.v1", path: "" }),
    ]);
  });

  test("output that fails a plain agent's workflow.yaml schema names the field", async () => {
    const node = await compileAgent(SCHEMA_CHECKED, "ask");

    expect(await findDefaultIssues(node, { ok: "yes" }, [], runFolder())).toEqual([
      expect.objectContaining({ kind: "output-schema", schema: "result", path: "ok" }),
    ]);
    expect(await findDefaultIssues(node, { ok: true }, [], runFolder())).toEqual([]);
  });
});

describe("findConsumedArtifacts", () => {
  const nodeRun = (
    status: NodeRun["status"],
    completedAt: string | null,
    path: string,
  ): NodeRun => ({
    nodeRunId: `nr-${path}`,
    nodeType: "agent",
    status,
    startedAt: "2026-09-28T09:00:00Z",
    completedAt,
    artifacts: [file("plan", `artifacts/${path}`)],
  });

  test("hands over the newest completed run's artifact of each consumed type, nested runs too", async () => {
    const consumer = await compileAgent(
      "  - { id: make, type: agent, stage: stages/producer, input: {} }\n  - { id: use, type: agent, stage: stages/consumer, dependsOn: [make], input: {} }\n",
      "use",
    );
    if (consumer.stage === undefined) throw new Error("use has no stage");
    const runs = {
      make: nodeRun("completed", "2026-09-28T09:01:00Z", "first.md"),
      loop: {
        ...nodeRun("running", null, "none.md"),
        nodes: { remake: nodeRun("completed", "2026-09-28T09:02:00Z", "second.md") },
      },
      redo: nodeRun("failed", "2026-09-28T09:03:00Z", "failed.md"),
    };

    expect(findConsumedArtifacts(consumer.stage, runs)).toEqual([
      file("plan", "artifacts/second.md"),
    ]);
  });
});

describe("artifactPaths", () => {
  test("keys a file by its type, or TYPE:NAME when named otherwise, and a link by its url", () => {
    const link = { type: "pull-request", name: "lydia", url: "https://github.com/o/lydia/pull/1" };

    expect(
      artifactPaths("/run", [file("plan"), file("plan", "artifacts/b.md", "b"), link]),
    ).toEqual({
      plan: "/run/artifacts/plan.md",
      "plan:b": "/run/artifacts/b.md",
      "pull-request:lydia": link.url,
    });
  });
});

describe("runVerifiers", () => {
  const SKILLS = tempDir();
  writeStages(SKILLS, {});

  const fn = (id: string, functionName: string, extra: object = {}) =>
    VerifierSchema.parse({ id, module: "./verifiers.ts", functionName, ...extra });
  const script = (id: string, body: string) =>
    VerifierSchema.parse({ id, runtime: "sh", script: body });

  const verify = async (verifiers: ReturnType<typeof fn>[], cwd = tempDir()) =>
    runVerifiers(
      await loadVerifiers(verifiers, SKILLS),
      { run: "feat-x", nodeRunId: "nr-1", output: { ok: true }, artifacts: [], nodeInput: null },
      cwd,
      1,
    );

  test("returns a run per verifier in the stage's order, and a done issue for each that did not pass", async () => {
    const runs = await verify([fn("ok", "pass"), fn("lint", "fail"), fn("more", "failTwo")]);

    const base = { attempt: 1, durationMs: expect.any(Number) };
    const lint = [{ message: "fail one", path: "a.ts", line: 3, hint: "fix a" }];
    expect(runs).toEqual([
      { ...base, verifier: "ok", status: "passed", findings: [] },
      { ...base, verifier: "lint", status: "failed", findings: lint },
      { ...base, verifier: "more", status: "failed", findings: [{ message: "fail two" }] },
    ]);
    expect(issuesOf(runs)).toEqual([
      { kind: "verifier", verifier: "lint", findings: lint },
      { kind: "verifier", verifier: "more", findings: [{ message: "fail two" }] },
    ]);
  });

  test.each([
    ["throws", fn("v", "throws"), "threw", "boom"],
    [
      "outlives its timeout",
      fn("v", "slow", { timeoutMs: 100 }),
      "timeout",
      "timed out after 100ms",
    ],
    ["fails with no finding", fn("v", "badShape"), "bad-output", "finding"],
    ["exits non-zero", script("v", "echo nope >&2; exit 3"), "exit", "exit 3: nope"],
    ["prints text that is not JSON", script("v", "echo not-json"), "bad-output", "not JSON"],
    ["prints nothing", script("v", "true"), "bad-output", "not JSON"],
  ] as const)(
    "a verifier that %s errors with its own reason, which fails the done",
    async (_label, verifier, reason, text) => {
      const runs = await verify([verifier]);

      expect(runs).toEqual([
        expect.objectContaining({
          status: "error",
          findings: [],
          error: { reason, message: expect.stringContaining(text) },
        }),
      ]);
      expect(issuesOf(runs)).toEqual([
        { kind: "verifier-error", verifier: "v", reason, message: expect.stringContaining(text) },
      ]);
    },
  );

  test("a script verifier gets the input and its args as JSON on stdin and runs in the run's cwd", async () => {
    const cwd = tempDir();

    const runs = await verify(
      [script("s", `cat > "$PWD/stdin.json"; printf '{"pass":true}'`)],
      cwd,
    );

    expect(runs).toMatchObject([{ verifier: "s", status: "passed" }]);
    expect(JSON.parse(readFileSync(join(cwd, "stdin.json"), "utf8"))).toEqual({
      run: "feat-x",
      nodeRunId: "nr-1",
      output: { ok: true },
      artifacts: [],
      args: {},
      nodeInput: null,
    });
  });
});

// init records the repo's branch and sha, so a run needs a repo with a commit.
const makeRepo = (): string => {
  const cwd = tempDir();
  const git = (...args: string[]) => execFileSync("git", args, { cwd });
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  return cwd;
};

// A run of NODES initialized in a fresh repo, with the demo stages and STAGES under stages/.
const startedRun = async (nodes: string, stages: Readonly<Record<string, DemoStage>> = {}) => {
  const cwd = makeRepo();
  writeStages(join(cwd, "stages"), { ...STAGES, ...stages });
  const workflowPath = join(cwd, "workflow.yaml");
  writeFileSync(workflowPath, `name: t\nnodes:\n${nodes}`);
  const config = join(cwd, "orchestrate.config.json");
  writeFileSync(config, '{ "version": 2 }\n');
  const registry = createRegistry(join(tempDir(), "registry.json"));
  const run: WorkflowRun = {
    id: "r-1",
    workflow: "t",
    workflowPath,
    inputs: {},
    cwd,
    sessions: [],
    name: null,
    terminal: null,
    config,
    tiers: null,
    createdAt: new Date().toISOString(),
  };
  await registry.addRun(run);
  const init = await initializeRun({
    registry,
    runId: run.id,
    name: "feat-x",
    git: createGit(),
    log: noopLogger,
    modelSwitchAgents: new Set(),
  });
  if (!init.ok) throw new Error(init.error);
  return { id: run.id, cwd, name: "feat-x" } satisfies RunRef;
};

const nextNodeRunId = async (run: RunRef): Promise<string> => {
  const reply = await nextStep(run, new Set());
  if (!reply.ok || !("nodeRunId" in reply.value)) throw new Error(JSON.stringify(reply));
  return reply.value.nodeRunId;
};

const finish = (
  run: RunRef,
  nodeRunId: string,
  output = '{"ok":true}',
  artifacts: ArtifactRef[] = [],
) => finishStep(run, nodeRunId, { output, summary: "Did the work." }, artifacts);

const eventsOf = (run: RunRef) => jsonlEventStore(runDirOf(run.cwd, run.name)).read();

const CHECKED = "  - { id: use, type: agent, stage: stages/checked, input: {} }\n";
const checked = (verifiers: string) => ({ checked: { verifiers } });
const fnVerifier = (id: string, functionName: string, extra = "") =>
  `{ id: ${id}, module: ../verifiers.ts, functionName: ${functionName}${extra} }`;

describe("finishStep", () => {
  test("records the artifacts a done registers as given, links and undeclared files too", async () => {
    const run = await startedRun(
      "  - { id: make, type: agent, stage: stages/producer, input: {} }\n",
    );
    const nodeRunId = await nextNodeRunId(run);
    writeFileSync(join(runDirOf(run.cwd, run.name), "artifacts", "plan.md"), "plan\n");
    writeFileSync(join(runDirOf(run.cwd, run.name), "artifacts", "notes.md"), "notes\n");
    const link = { type: "pull-request", name: "lydia", url: "https://github.com/o/lydia/pull/1" };
    const artifacts = [file("plan"), file("notes"), link];

    const done = await finish(run, nodeRunId, "{}", artifacts);

    expect(done).toMatchObject({ ok: true, value: { status: "completed" } });
    const completed = (await eventsOf(run)).find(
      (event) => event.type === "workflow.node.completed",
    );
    expect(completed?.payload).toMatchObject({ artifacts });
  });

  test("a done its default checks refuse runs no verifier and logs none", async () => {
    const seen = join(tempDir(), "seen.json");
    const record = fnVerifier("rec", "record", `, args: { file: ${JSON.stringify(seen)} }`);
    const run = await startedRun(CHECKED, checked(`[${record}]`));
    const nodeRunId = await nextNodeRunId(run);

    const done = await finish(run, nodeRunId, "[]");

    expect(done).toMatchObject({
      ok: false,
      error: { kind: "validation", retryable: true, issues: [{ kind: "output-schema" }] },
    });
    expect(existsSync(seen)).toBe(false);
    expect((await eventsOf(run)).map((event) => event.type)).not.toContain("orchestrate.verifier");
  });

  test("logs each verifier run as an orchestrate.verifier event on the node", async () => {
    const verifiers = `[${fnVerifier("ok", "pass")}, ${fnVerifier("boom", "throws")}]`;
    const run = await startedRun(CHECKED, checked(verifiers));
    const nodeRunId = await nextNodeRunId(run);

    await finish(run, nodeRunId);

    const logged = (await eventsOf(run)).filter((event) => event.type === "orchestrate.verifier");
    const envelope = { source: "orchestrate", nodeId: "use", nodeRunId, stage: "checked" };
    const base = { attempt: 1, durationMs: expect.any(Number) };
    expect(logged).toEqual([
      expect.objectContaining({
        ...envelope,
        payload: { ...base, verifier: "ok", status: "passed", findings: [] },
      }),
      expect.objectContaining({
        ...envelope,
        payload: {
          ...base,
          verifier: "boom",
          status: "error",
          findings: [],
          error: { reason: "threw", message: "boom" },
        },
      }),
    ]);
  });

  test("SC317: dones rejected before a resume still count, so the third rejection after it fails the node", async () => {
    const run = await startedRun(CHECKED, checked(`[${fnVerifier("lint", "fail")}]`));
    const first = await nextNodeRunId(run);
    for (const _ of [1, 2]) {
      expect(await finish(run, first)).toMatchObject({ ok: false, error: { retryable: true } });
    }

    expect(await interruptOpenSteps(run)).toMatchObject({ ok: true });
    const again = await nextNodeRunId(run);
    const last = await finish(run, again);

    expect(again).not.toBe(first);
    expect(last).toMatchObject({
      ok: false,
      error: { kind: "verify-exhausted", retryable: false },
    });
    const failed = (await eventsOf(run)).filter((event) => event.type === "workflow.node.failed");
    expect(failed.map((event) => event.nodeRunId)).toEqual([again]);
  });
});
