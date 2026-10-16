import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Workflow, WorkflowSchema } from "@yok/core";
import type { Blocker, NodeRun, State, WorkflowRun } from "@yok/sdk";
import { runDirOf } from "@yok/sdk";
import { listSteps, readRunFiles, summarizeRun } from "./overview.ts";

const runRecord = (overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: "r-1",
  workflow: "task",
  workflowPath: "/w.yaml",
  inputs: {},
  cwd: "/x/acme",
  sessions: [],
  name: "feat-x",
  terminal: null,
  config: null,
  tiers: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const nodeRun = (status: NodeRun["status"], extra: Partial<NodeRun> = {}): NodeRun => ({
  nodeRunId: "n",
  nodeType: "exec",
  status,
  startedAt: null,
  completedAt: null,
  artifacts: [],
  ...extra,
});

const stateOf = (overrides: Partial<State> = {}): State => ({
  schemaVersion: 1,
  lastEventSeq: 1,
  runId: "r-1",
  runName: "feat-x",
  runDir: "/x/acme/.yok/feat-x",
  version: "0.0.0",
  workflow: { name: "task", path: "workflow.yaml" },
  input: {},
  scope: null,
  startedAt: "2026-01-01T00:01:00.000Z",
  completedAt: null,
  status: "running",
  workspace: {
    type: "mono",
    path: "/x/acme",
    repositories: {
      acme: { path: "/x/acme", git: { branch: "main", baseBranch: "main", startSha: "abc" } },
    },
  },
  nodeRuns: {},
  activeSessions: [],
  tiers: null,
  eventHandlers: {},
  subscribers: {},
  ...overrides,
});

const workflowOf = (ids: readonly string[]): Workflow =>
  WorkflowSchema.parse({
    name: "task",
    nodes: ids.map((id) => ({ id, type: "exec", input: {}, runtime: "sh", script: "true" })),
  });

describe("summarizeRun", () => {
  test("SC101: a completed run with 3 ended nodes reads 3 of 3 steps, no current step, its state's times, prompt and folder", () => {
    const state = stateOf({
      status: "completed",
      completedAt: "2026-01-01T00:41:00.000Z",
      nodeRuns: {
        a: nodeRun("completed"),
        b: nodeRun("skipped", {
          output: { reason: "when-false", proof: { expression: "x", value: false } },
        }),
        c: nodeRun("completed"),
      },
    });
    const summary = summarizeRun(
      runRecord({ inputs: { prompt: "Add CSV export" } }),
      {
        state,
        workflow: workflowOf(["a", "b", "c"]),
        hasRunDir: true,
      },
      false,
    );
    expect(summary).toMatchObject({
      status: "completed",
      steps: { done: 3, total: 3 },
      current: null,
      startedAt: "2026-01-01T00:01:00.000Z",
      completedAt: "2026-01-01T00:41:00.000Z",
      prompt: "Add CSV export",
      folder: "acme",
      cwd: "/x/acme",
    });
  });
});

describe("summarizeRun on a running run", () => {
  test("SC102: qa-loop running with fix done and qa running reads current step qa-loop.qa and 1 step finished", () => {
    const state = stateOf({
      nodeRuns: {
        "ticket-fetcher": nodeRun("completed"),
        "qa-loop": nodeRun("running", {
          nodes: { fix: nodeRun("completed"), qa: nodeRun("running") },
        }),
      },
    });
    const summary = summarizeRun(runRecord(), { state, workflow: null, hasRunDir: true }, true);
    expect(summary).toMatchObject({ current: "qa-loop.qa", steps: { done: 1 } });
  });
});

const repoWithPr = (url: string): State["workspace"] => ({
  type: "mono",
  path: "/x/acme",
  repositories: {
    acme: {
      path: "/x/acme",
      git: { branch: "feat", baseBranch: "main", startSha: "abc", pr: { id: "5", url } },
    },
  },
});

describe("summarizeRun PR link", () => {
  test.each([
    {
      given: "a pr node's output names pull/3 and another node's input quotes pull/9",
      state: stateOf({
        nodeRuns: {
          ticket: nodeRun("completed", { input: { task: "see https://github.com/o/r/pull/9" } }),
          pr: nodeRun("completed", {
            output: "PR_ACTION: created\nPR_URL: https://github.com/o/r/pull/3\nPR_NUMBER: 3",
          }),
        },
      }),
      pr: "https://github.com/o/r/pull/3",
    },
    {
      given: "a repository's git.pr is pull/5",
      state: stateOf({ workspace: repoWithPr("https://github.com/o/r/pull/5") }),
      pr: "https://github.com/o/r/pull/5",
    },
    {
      given: "a repository's git.pr is a javascript: URL and a pr node's output names pull/3",
      state: stateOf({
        workspace: repoWithPr("javascript:alert(1)"),
        nodeRuns: { pr: nodeRun("completed", { output: "PR_URL: https://github.com/o/r/pull/3" }) },
      }),
      pr: "https://github.com/o/r/pull/3",
    },
    {
      given: "a repository's git.pr is a javascript: URL and nothing else names a PR",
      state: stateOf({ workspace: repoWithPr("javascript:alert(1)") }),
      pr: null,
    },
    { given: "no PR anywhere", state: stateOf(), pr: null },
  ])("SC103: $given → pr is $pr", ({ state, pr }) => {
    expect(summarizeRun(runRecord(), { state, workflow: null, hasRunDir: true }, true).pr).toBe(pr);
  });
});

describe("summarizeRun before or without a state", () => {
  test("SC104: an unnamed run is starting and a named run with no readable files is missing, both with no step total and the registry's start", () => {
    const none = { state: null, workflow: null, hasRunDir: false };
    const starting = summarizeRun(runRecord({ name: null }), none, null);
    const missing = summarizeRun(runRecord(), none, null);
    expect([starting, missing]).toMatchObject([
      { status: "starting", steps: { total: null }, startedAt: "2026-01-01T00:00:00.000Z" },
      { status: "missing", steps: { total: null }, startedAt: "2026-01-01T00:00:00.000Z" },
    ]);
  });

  test("EC2: a run folder whose state.json is not JSON reads unreadable, and a run with no folder reads missing", async () => {
    const corrupt = runRecord({ cwd: mkdtempSync(join(tmpdir(), "yok-overview-")) });
    const runDir = runDirOf(corrupt.cwd, "feat-x");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "state.json"), "{not json");
    const absent = runRecord({ cwd: mkdtempSync(join(tmpdir(), "yok-overview-")) });
    const statuses = await Promise.all(
      [corrupt, absent].map(async (run) => summarizeRun(run, await readRunFiles(run), null).status),
    );
    expect(statuses).toEqual(["unreadable", "missing"]);
  });
});

const question: Blocker = {
  reason: "question",
  node: "planning",
  since: "2026-01-01T00:05:00.000Z",
  details: { questions: [{ question: "Which store?", options: ["a", "b"] }] },
};

const planningRunning = {
  planning: nodeRun("running", {
    agentState: {
      agent: "claude",
      tier: "high",
      model: "claude-opus-5-5",
      sessionId: null,
      tokens: null,
    },
  }),
};

describe("summarizeRun on a blocked run", () => {
  const onPlanning = { agent: "claude", tier: "high", model: "claude-opus-5-5" };
  test("SC111: a blocked state with a question on planning reads blocked with that blocker and planning's agent, tier and model, and the same state running reads running with no blocker", () => {
    const blocked = stateOf({ status: "blocked", blocker: question, nodeRuns: planningRunning });
    const running = stateOf({ nodeRuns: planningRunning });
    const summaries = [blocked, running].map((state) =>
      summarizeRun(runRecord(), { state, workflow: null, hasRunDir: true }, true),
    );
    expect(summaries).toMatchObject([
      { status: "blocked", blocker: question, current: "planning", ...onPlanning },
      { status: "running", blocker: null, current: "planning", ...onPlanning },
    ]);
  });
});

describe("summarizeRun with a dead terminal", () => {
  test.each([
    {
      given: "running",
      terminal: "dead",
      alive: false,
      state: stateOf({ nodeRuns: planningRunning }),
      status: "gone",
    },
    {
      given: "blocked",
      terminal: "dead",
      alive: false,
      state: stateOf({ status: "blocked", blocker: question, nodeRuns: planningRunning }),
      status: "gone",
    },
    {
      given: "completed",
      terminal: "dead",
      alive: false,
      state: stateOf({ status: "completed" }),
      status: "completed",
    },
    {
      given: "running",
      terminal: "not asked about",
      alive: null,
      state: stateOf({ nodeRuns: planningRunning }),
      status: "running",
    },
  ])(
    "SC112: a $given state whose terminal is $terminal reads $status with no blocker",
    ({ state, alive, status }) => {
      expect(
        summarizeRun(runRecord(), { state, workflow: null, hasRunDir: true }, alive),
      ).toMatchObject({
        status,
        blocker: null,
      });
    },
  );
});

const exec = (id: string, dependsOn: readonly string[] = []) => ({
  id,
  type: "exec",
  input: {},
  runtime: "sh",
  script: "true",
  dependsOn,
});

const workflowWith = (nodes: readonly unknown[]): Workflow =>
  WorkflowSchema.parse({ name: "task", nodes });

describe("listSteps", () => {
  test("SC119: review (after build) listed before build, then plan, with only build completed, comes out build, review, plan with review and plan pending and empty", () => {
    const workflow = workflowWith([exec("review", ["build"]), exec("build"), exec("plan")]);
    const runs = {
      build: nodeRun("completed", {
        startedAt: "2026-01-01T00:01:00.000Z",
        completedAt: "2026-01-01T00:02:00.000Z",
      }),
    };

    const steps = listSteps(workflow.nodes, runs);

    expect(steps.map((step) => step.id)).toEqual(["build", "review", "plan"]);
    expect(steps[0]).toMatchObject({ status: "completed", startedAt: "2026-01-01T00:01:00.000Z" });
    const empty = {
      status: "pending",
      startedAt: null,
      completedAt: null,
      model: null,
      reason: null,
      output: null,
    };
    expect(steps.slice(1)).toMatchObject([empty, empty]);
  });
});

describe("listSteps containers", () => {
  test("SC120: a loop on pass 2, the switch case that ran, an unrun switch, a switch that took its default and an include's runs come out as children", () => {
    const workflow = workflowWith([
      {
        id: "qa-loop",
        type: "loop",
        input: {},
        until: "{{ true }}",
        maxIterations: 3,
        nodes: [exec("fix"), exec("qa", ["fix"])],
      },
      {
        id: "route",
        type: "switch",
        input: {},
        expression: "{{ 'big' }}",
        cases: [
          { id: "big", value: "big", nodes: [exec("split")] },
          { id: "small", value: "small", nodes: [exec("tiny")] },
        ],
      },
      {
        id: "other",
        type: "switch",
        input: {},
        expression: "{{ 'x' }}",
        cases: [{ id: "x", value: "x", nodes: [exec("never")] }],
      },
      {
        id: "fallback",
        type: "switch",
        input: {},
        expression: "{{ 'z' }}",
        cases: [{ id: "x", value: "x", nodes: [exec("never")] }],
        default: [exec("guess"), exec("check", ["guess"])],
      },
      { id: "sub", type: "include", input: {}, workflow: "sub.yaml" },
    ]);
    const runs = {
      "qa-loop": nodeRun("running", {
        nodeType: "loop",
        iteration: 2,
        nodes: { fix: nodeRun("completed") },
      }),
      route: nodeRun("running", {
        nodeType: "switch",
        branch: "big",
        nodes: { split: nodeRun("running") },
      }),
      fallback: nodeRun("running", {
        nodeType: "switch",
        branch: "default",
        nodes: { guess: nodeRun("completed") },
      }),
      sub: nodeRun("running", {
        nodeType: "include",
        nodes: { a: nodeRun("completed"), b: nodeRun("running") },
      }),
    };

    const [loop, route, other, fallback, sub] = listSteps(workflow.nodes, runs);

    expect(loop).toMatchObject({
      iteration: 2,
      children: [
        { id: "fix", path: "qa-loop.fix", status: "completed" },
        { id: "qa", path: "qa-loop.qa", status: "pending" },
      ],
    });
    expect(route?.children.map((step) => step.path)).toEqual(["route.split"]);
    expect(other?.children).toEqual([]);
    expect(fallback?.children).toMatchObject([
      { path: "fallback.guess", status: "completed" },
      { path: "fallback.check", status: "pending" },
    ]);
    expect(sub?.children).toMatchObject([
      { id: "a", path: "sub.a", status: "completed" },
      { id: "b", path: "sub.b", status: "running" },
    ]);
  });
});

describe("listSteps details", () => {
  const long = "x".repeat(5000);
  test.each([
    {
      given: "failed with exit 1",
      run: nodeRun("failed", { output: { kind: "exec", message: "exit 1" } }),
      expected: { reason: "exit 1", output: null },
    },
    {
      given: "skipped on a false condition",
      run: nodeRun("skipped", {
        output: { reason: "when-false", proof: { expression: "x", value: false } },
      }),
      expected: { reason: "condition was false: x", output: null },
    },
    {
      given: "skipped after a and b were skipped",
      run: nodeRun("skipped", {
        output: { reason: "dependency-skipped", proof: { dependencies: ["a", "b"] } },
      }),
      expected: { reason: "skipped because a, b were skipped", output: null },
    },
    {
      given: "completed with a 5000-character output and a design file",
      run: nodeRun("completed", {
        output: long,
        artifacts: [{ type: "design", name: "design", path: "artifacts/design.md" }],
      }),
      expected: {
        reason: null,
        output: `${long.slice(0, 4000)}…`,
        artifacts: ["artifacts/design.md"],
      },
    },
    {
      given: "completed with an object output",
      run: nodeRun("completed", { output: { ok: true } }),
      expected: { reason: null, output: '{\n  "ok": true\n}' },
    },
  ])(
    "SC121: a step $given carries why it did not complete, or its output and files",
    ({ run, expected }) => {
      const [step] = listSteps(workflowWith([exec("x")]).nodes, { x: run });
      expect(step).toMatchObject(expected);
    },
  );
});

describe("listSteps agents", () => {
  test("SC122: design and qa-loop.qa carry the agent, tier and model they started on, and exec step baseline carries none", () => {
    const agentNode = (id: string) => ({ id, type: "agent", input: {}, stage: id });
    const workflow = workflowWith([
      agentNode("design"),
      {
        id: "qa-loop",
        type: "loop",
        input: {},
        until: "{{ true }}",
        maxIterations: 3,
        nodes: [agentNode("qa")],
      },
      exec("baseline"),
    ]);
    const agentState = (tier: string, model: string | null) => ({
      agent: "claude",
      tier,
      model,
      sessionId: null,
      tokens: null,
    });
    const runs = {
      design: nodeRun("completed", {
        nodeType: "agent",
        agentState: agentState("deep", "claude-opus-5-5"),
      }),
      "qa-loop": nodeRun("running", {
        nodeType: "loop",
        iteration: 1,
        nodes: {
          qa: nodeRun("running", { nodeType: "agent", agentState: agentState("fast", null) }),
        },
      }),
      baseline: nodeRun("completed"),
    };

    const [design, loop, baseline] = listSteps(workflow.nodes, runs);

    expect(design).toMatchObject({ agent: "claude", tier: "deep", model: "claude-opus-5-5" });
    expect(loop?.children[0]).toMatchObject({ agent: "claude", tier: "fast", model: null });
    expect(baseline).toMatchObject({ agent: null, tier: null, model: null });
  });
});
