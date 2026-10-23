import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Blocker,
  type Event,
  type JsonValue,
  type NodeRun,
  type State,
  StateSchema,
} from "./contracts.ts";
import { jsonlEventStore, memoryEventStore } from "./event-store.ts";
import {
  builtInHandlers,
  emitEvent,
  findRunningLeaf,
  foldModelSwitch,
  runDirOf,
  WorkspaceCreatedEvent,
} from "./events.ts";
import { emitRunEvent, projectEvents } from "./state.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("emitEvent", () => {
  test("SC1: an event emitted with no id is stored as seq 1 with a UUID, the current time and the given runId", async () => {
    const store = memoryEventStore();
    const before = Date.now();
    const result = await emitEvent(store, "r-1", {
      type: "custom.skill.note",
      source: "test",
      payload: { a: 1 },
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.value).toMatchObject({ seq: 1, runId: "r-1", payload: { a: 1 } });
    expect(result.value.id).toMatch(UUID);
    expect(Date.parse(result.value.ts)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(result.value.ts)).toBeLessThanOrEqual(Date.now() + 1000);
    expect(await store.read()).toEqual([result.value]);
  });

  test.each([
    ["completed", { output: "hi\n" }],
    ["failed", { error: { kind: "exit", message: "exit 1" } }],
  ])("workflow.node.%s carries a script's process record", async (outcome, fields) => {
    const result = await emitEvent(memoryEventStore(), "r-1", {
      type: `workflow.node.${outcome}`,
      source: "test",
      nodeId: "a",
      nodeRunId: "a",
      payload: {
        nodeType: "exec",
        attempts: 1,
        process: { stdout: "hi\n", stderr: "", exitCode: 0 },
        ...fields,
      },
    });
    expect(result.ok).toBe(true);
  });
});

describe("emitRunEvent", () => {
  test("SC31: stores the event in the run's .yok/NAME folder with the run's id", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "repo-"));
    const run = { id: "r-1", cwd, name: "fix-login" };

    const result = await emitRunEvent(run, {
      type: "custom.skill.note",
      source: "test",
      payload: { a: 1 },
    });

    if (!result.ok) throw new Error(result.error);
    expect(result.value).toMatchObject({ seq: 1, runId: "r-1" });
    expect(runDirOf(cwd, "fix-login")).toBe(join(cwd, ".yok", "fix-login"));
    expect(await jsonlEventStore(runDirOf(cwd, "fix-login")).read()).toEqual([result.value]);
  });

  test("brings the run's state.json up to date, so a workspace event moves state.workspace", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "repo-"));
    const run = { id: "r-1", cwd, name: "fix-login" };
    const dir = runDirOf(cwd, "fix-login");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "state.json"), JSON.stringify(seed));

    const result = await emitRunEvent(run, {
      type: "workspace.created",
      source: "test",
      payload: createdPayload("multi", { api: repository(`${WS_DIR}/api`) }),
    });

    if (!result.ok) throw new Error(result.error);
    const state = StateSchema.parse(JSON.parse(await readFile(join(dir, "state.json"), "utf8")));
    expect(state.lastEventSeq).toBe(1);
    expect(state.workspace.type).toBe("multi");
    expect(state.workspace.path).toBe(WS_DIR);
    expect(Object.keys(state.workspace.repositories)).toEqual(["api"]);
  });
});

const seed: State = {
  schemaVersion: 1,
  lastEventSeq: 0,
  runId: "r-1",
  runName: "add-login",
  runDir: "/work/.yok/add-login",
  version: "2.0.0",
  workflow: { name: "feature", path: "workflow.yaml" },
  input: {},
  scope: null,
  startedAt: "2026-09-26T10:00:00Z",
  completedAt: null,
  status: "running",
  workspace: {
    type: "mono",
    path: "/work",
    repositories: {
      app: { path: "/work", git: { branch: "b", baseBranch: "main", startSha: "a" } },
    },
  },
  tiers: null,
  nodeRuns: {},
  activeSessions: [],
  eventHandlers: {},
  subscribers: {},
};

const nodeEvent = (
  seq: number,
  outcome: string,
  ids: { nodeId: string; nodeRunId: string },
  payload: JsonValue,
): Event => ({
  schemaVersion: 1,
  seq,
  id: `evt-${seq}`,
  ts: `2026-09-26T10:00:0${seq}Z`,
  type: `workflow.node.${outcome}`,
  source: "test",
  runId: "r-1",
  ...ids,
  payload,
});

const project = (events: readonly Event[]): State =>
  projectEvents({ state: seed, events, handlers: builtInHandlers });

const build = { nodeId: "build", nodeRunId: "build" };
const skip = { reason: "when-false", proof: { expression: "inputs.quick", value: false } };

describe("builtInHandlers", () => {
  test("workflow.session.replaced swaps the old session for the new one in activeSessions", () => {
    const replaced = (seq: number, previousSessionId: string, sessionId: string): Event => ({
      schemaVersion: 1,
      seq,
      id: `evt-${seq}`,
      ts: "2026-09-27T09:00:00Z",
      type: "workflow.session.replaced",
      source: "orchestrate",
      runId: "r-1",
      payload: { agent: "claude", previousSessionId, sessionId },
    });
    const state = projectEvents({
      state: { ...seed, activeSessions: [{ agent: "claude", sessionId: "A" }] },
      events: [replaced(1, "A", "B"), replaced(2, "gone", "C")],
      handlers: builtInHandlers,
    });

    expect(state.activeSessions).toEqual([
      { agent: "claude", sessionId: "B" },
      { agent: "claude", sessionId: "C" },
    ]);
  });

  test("workflow.started sets the run's startedAt to the event's time", () => {
    const state = project([
      {
        schemaVersion: 1,
        seq: 1,
        id: "workflow-started",
        ts: "2026-09-27T09:00:00Z",
        type: "workflow.started",
        source: "test",
        runId: "r-1",
        payload: { workflow: "feature", inputs: {} },
      },
    ]);
    expect(state.startedAt).toBe("2026-09-27T09:00:00Z");
  });

  test("a started node keeps whether it posts to the thread, and a completed one keeps its summary", () => {
    const state = project([
      nodeEvent(1, "started", build, { nodeType: "agent", notify: false }),
      nodeEvent(2, "completed", build, {
        nodeType: "agent",
        attempts: 1,
        output: "ok",
        summary: "Built the app.",
      }),
    ]);
    expect(state.nodeRuns.build).toMatchObject({ notify: false, summary: "Built the app." });
    expect(StateSchema.safeParse(state).success).toBe(true);
  });

  test("SC7: a failed node records status, end time and its error as output, without the stack or process", () => {
    const message = "x".repeat(500);
    const state = project([
      nodeEvent(1, "started", build, { nodeType: "exec" }),
      nodeEvent(2, "failed", build, {
        nodeType: "exec",
        attempts: 2,
        error: { kind: "exit", message, stack: "Error: exit\n    at run" },
        process: { stdout: "", stderr: "boom", exitCode: 1 },
      }),
    ]);
    expect(state.nodeRuns.build).toEqual({
      nodeRunId: "build",
      nodeType: "exec",
      status: "failed",
      startedAt: "2026-09-26T10:00:01Z",
      completedAt: "2026-09-26T10:00:02Z",
      artifacts: [],
      output: { kind: "exit", message },
    });
    expect(StateSchema.safeParse(state).success).toBe(true);
  });

  test("SC8: a node that is skipped without starting still appears, started and ended at the skip, with its skip as output", () => {
    const lint = { nodeId: "lint", nodeRunId: "lint" };
    const state = project([nodeEvent(1, "skipped", lint, { nodeType: "exec", attempts: 0, skip })]);
    expect(state.nodeRuns.lint).toEqual({
      nodeRunId: "lint",
      nodeType: "exec",
      status: "skipped",
      startedAt: "2026-09-26T10:00:01Z",
      completedAt: "2026-09-26T10:00:01Z",
      artifacts: [],
      output: skip,
    });
  });

  test("SC308: an interrupted node keeps its run id and start, gains an end time, and has status interrupted", () => {
    const state = project([
      nodeEvent(1, "started", build, { nodeType: "agent", input: { n: 1 } }),
      nodeEvent(2, "interrupted", build, { nodeType: "agent", attempts: 1 }),
    ]);
    expect(state.nodeRuns.build).toEqual({
      nodeRunId: "build",
      nodeType: "agent",
      status: "interrupted",
      startedAt: "2026-09-26T10:00:01Z",
      completedAt: "2026-09-26T10:00:02Z",
      artifacts: [],
      input: { n: 1 },
    });
    expect(StateSchema.safeParse(state).success).toBe(true);
  });

  test("a completed script node keeps only its output value in state; the process record stays in the event", () => {
    const state = project([
      nodeEvent(1, "started", build, { nodeType: "exec" }),
      nodeEvent(2, "completed", build, {
        nodeType: "exec",
        attempts: 1,
        output: { pass: true },
        process: { stdout: '{"pass":true}', stderr: "", exitCode: 0 },
      }),
    ]);
    expect(state.nodeRuns.build?.output).toEqual({ pass: true });
    expect(JSON.stringify(state)).not.toContain("stdout");
  });

  test.each([
    [
      "with an error records it as output",
      { error: { kind: "cancelled", message: "stopped" } },
      { kind: "cancelled", message: "stopped" },
    ],
    ["without an error has no output", {}, undefined],
  ])("a cancelled node %s", (_label, extra, output) => {
    const state = project([
      nodeEvent(1, "started", build, { nodeType: "agent" }),
      nodeEvent(2, "cancelled", build, { nodeType: "agent", attempts: 1, ...extra }),
    ]);
    expect(state.nodeRuns.build?.status).toBe("cancelled");
    expect(state.nodeRuns.build?.output).toEqual(output);
    expect(StateSchema.safeParse(state).success).toBe(true);
  });

  test("a loop cancelled without an error drops the output its last pass left", () => {
    const state = project([
      nodeEvent(1, "started", build, { nodeType: "loop" }),
      nodeEvent(2, "iterated", build, { nodeType: "loop", iteration: 2, output: { pass: false } }),
      nodeEvent(3, "cancelled", build, { nodeType: "loop", attempts: 1 }),
    ]);
    expect(state.nodeRuns.build?.status).toBe("cancelled");
    expect(state.nodeRuns.build?.output).toBeUndefined();
  });

  test("IW8 — a node run holds the input from its started event and the output from its completed event; a pair without them projects as before", () => {
    const fresh = { nodeId: "fresh", nodeRunId: "nr-00000001" };
    const legacy = { nodeId: "legacy", nodeRunId: "legacy" };
    const state = project([
      nodeEvent(1, "started", fresh, { nodeType: "exec", input: { n: 1 } }),
      nodeEvent(2, "completed", fresh, { nodeType: "exec", attempts: 1, output: { n: 2 } }),
      nodeEvent(3, "started", legacy, { nodeType: "exec" }),
      nodeEvent(4, "completed", legacy, { nodeType: "exec", attempts: 1 }),
    ]);
    expect(state.nodeRuns.fresh).toMatchObject({
      nodeRunId: "nr-00000001",
      input: { n: 1 },
      output: { n: 2 },
    });
    expect(state.nodeRuns.legacy).not.toHaveProperty("input");
    expect(state.nodeRuns.legacy).not.toHaveProperty("output");
    expect(StateSchema.safeParse(state).success).toBe(true);
  });

  test("a node inside a container lands in that container's nodes, under its own id, at any depth", () => {
    const state = project([
      nodeEvent(
        1,
        "started",
        { nodeId: "fix", nodeRunId: "nr-1" },
        { nodeType: "loop", input: {} },
      ),
      nodeEvent(
        2,
        "skipped",
        { nodeId: "lint", nodeRunId: "nr-2" },
        {
          nodeType: "exec",
          attempts: 0,
          skip,
          parents: ["fix"],
        },
      ),
      nodeEvent(
        3,
        "started",
        { nodeId: "pick", nodeRunId: "nr-3" },
        {
          nodeType: "switch",
          branch: "a",
          parents: ["fix"],
        },
      ),
      nodeEvent(
        4,
        "started",
        { nodeId: "act", nodeRunId: "nr-4" },
        {
          nodeType: "exec",
          parents: ["fix", "pick"],
        },
      ),
    ]);
    expect(state.nodeRuns.fix).toMatchObject({ status: "running", iteration: 1 });
    expect(state.nodeRuns.fix?.nodes?.lint).toMatchObject({ nodeRunId: "nr-2", status: "skipped" });
    expect(state.nodeRuns.fix?.nodes?.pick).toMatchObject({ branch: "a", status: "running" });
    expect(state.nodeRuns.fix?.nodes?.pick?.nodes?.act).toMatchObject({ status: "running" });
    expect(Object.keys(state.nodeRuns)).toEqual(["fix"]);
    expect(StateSchema.safeParse(state).success).toBe(true);
  });

  test("a node whose container is not in state is refused, naming the container", () => {
    expect(() =>
      project([
        nodeEvent(
          1,
          "started",
          { nodeId: "act", nodeRunId: "nr-1" },
          {
            nodeType: "exec",
            parents: ["ghost"],
          },
        ),
      ]),
    ).toThrow(/ghost/);
  });

  test("workflow.node.iterated moves a loop to its next pass: new pass number, last pass's output, children cleared", () => {
    const fix = { nodeId: "fix", nodeRunId: "nr-1" };
    const state = project([
      nodeEvent(1, "started", fix, { nodeType: "loop", input: {} }),
      nodeEvent(
        2,
        "completed",
        { nodeId: "test", nodeRunId: "nr-2" },
        {
          nodeType: "exec",
          attempts: 1,
          output: "p1",
          parents: ["fix"],
        },
      ),
      nodeEvent(3, "iterated", fix, { nodeType: "loop", iteration: 2, output: { test: "p1" } }),
    ]);
    expect(state.nodeRuns.fix).toMatchObject({
      nodeRunId: "nr-1",
      status: "running",
      iteration: 2,
      output: { test: "p1" },
      nodes: {},
    });
  });

  test("workflow.completed and workflow.failed set the run's status and completedAt", () => {
    const ended = (type: string): Event => ({
      schemaVersion: 1,
      seq: 1,
      id: "end",
      ts: "2026-09-28T09:00:00Z",
      type,
      source: "workflow",
      runId: "r-1",
      payload: {},
    });
    expect(project([ended("workflow.completed")])).toMatchObject({
      status: "completed",
      completedAt: "2026-09-28T09:00:00Z",
    });
    expect(project([ended("workflow.failed")]).status).toBe("failed");
  });

  test("SC9: a node started again replaces its entry, so state keeps only its latest run", () => {
    const state = project([
      nodeEvent(1, "started", { nodeId: "x", nodeRunId: "nr-1" }, { nodeType: "exec" }),
      nodeEvent(
        2,
        "completed",
        { nodeId: "x", nodeRunId: "nr-1" },
        {
          nodeType: "exec",
          attempts: 1,
          output: "first",
        },
      ),
      nodeEvent(3, "started", { nodeId: "x", nodeRunId: "nr-2" }, { nodeType: "exec" }),
    ]);
    expect(state.nodeRuns.x).toEqual({
      nodeRunId: "nr-2",
      nodeType: "exec",
      status: "running",
      startedAt: "2026-09-26T10:00:03Z",
      completedAt: null,
      artifacts: [],
    });
  });
});

const approvalRequested = (
  seq: number,
  ids: { nodeId: string; nodeRunId: string },
  payload: JsonValue,
): Event => ({
  ...nodeEvent(seq, "started", ids, payload),
  type: "artifact.approval.requested",
  source: "orchestrate",
});

describe("artifact.approval.requested", () => {
  const design = { nodeId: "design", nodeRunId: "nr-1" };
  const plan = { nodeId: "planning", nodeRunId: "nr-2" };

  test("SC1: an approval request marks the running node with the file it waits on, at the top level and inside a loop", () => {
    const state = project([
      nodeEvent(1, "started", design, { nodeType: "agent" }),
      approvalRequested(2, design, { path: "artifacts/design.md" }),
      nodeEvent(3, "started", { nodeId: "fix", nodeRunId: "nr-3" }, { nodeType: "loop" }),
      nodeEvent(4, "started", plan, { nodeType: "agent", parents: ["fix"] }),
      approvalRequested(5, plan, { path: "artifacts/design.md", parents: ["fix"] }),
    ]);
    expect(state.nodeRuns.design).toMatchObject({
      nodeRunId: "nr-1",
      awaitingApproval: "artifacts/design.md",
    });
    expect(state.nodeRuns.fix?.nodes?.planning).toMatchObject({
      nodeRunId: "nr-2",
      awaitingApproval: "artifacts/design.md",
    });
    expect(StateSchema.safeParse(state).success).toBe(true);
  });

  test("SC1: an approval request naming a node run that is not the node's current run is refused", () => {
    expect(() =>
      project([
        nodeEvent(1, "started", design, { nodeType: "agent" }),
        approvalRequested(
          2,
          { nodeId: "design", nodeRunId: "nr-old" },
          { path: "artifacts/design.md" },
        ),
      ]),
    ).toThrow(/nr-old/);
  });

  test("SC2: a node started again after an approval request no longer waits for approval", () => {
    const state = project([
      nodeEvent(1, "started", design, { nodeType: "agent" }),
      approvalRequested(2, design, { path: "artifacts/design.md" }),
      nodeEvent(3, "started", { nodeId: "design", nodeRunId: "nr-9" }, { nodeType: "agent" }),
    ]);
    expect(state.nodeRuns.design?.nodeRunId).toBe("nr-9");
    expect(state.nodeRuns.design).not.toHaveProperty("awaitingApproval");
  });

  test("a node that ends while waiting for approval no longer carries the wait", () => {
    const error = { kind: "exhausted", message: "done was rejected 3 times" };
    const ends = [
      nodeEvent(3, "completed", design, { nodeType: "agent", attempts: 1 }),
      nodeEvent(3, "failed", design, { nodeType: "agent", attempts: 3, error }),
    ];
    const ended = ends.map((end) =>
      project([
        nodeEvent(1, "started", design, { nodeType: "agent" }),
        approvalRequested(2, design, { path: "artifacts/design.md" }),
        end,
      ]),
    );
    for (const state of ended) {
      expect(state.nodeRuns.design).not.toHaveProperty("awaitingApproval");
    }
  });

  const commentAdded = (seq: number, kind: string, file: string): Event => ({
    schemaVersion: 1,
    seq,
    id: `evt-${seq}`,
    ts: `2026-09-26T10:00:0${seq}Z`,
    type: "artifact.comment.added",
    source: "viewer",
    runId: "r-1",
    payload: { comments: [{ id: `c-${seq}`, file, kind, text: "ok" }] },
  });

  const waitingOnTwoFiles = [
    nodeEvent(1, "started", design, { nodeType: "agent" }),
    approvalRequested(2, design, { path: "artifacts/design.md" }),
    nodeEvent(3, "started", { nodeId: "fix", nodeRunId: "nr-3" }, { nodeType: "loop" }),
    nodeEvent(4, "started", plan, { nodeType: "agent", parents: ["fix"] }),
    approvalRequested(5, plan, { path: "artifacts/plan.md", parents: ["fix"] }),
  ];

  test("an approve comment on artifacts/plan.md clears the wait on the nested node waiting on it, and leaves design waiting", () => {
    const state = project([...waitingOnTwoFiles, commentAdded(6, "approve", "artifacts/plan.md")]);
    expect(state.nodeRuns.fix?.nodes?.planning).not.toHaveProperty("awaitingApproval");
    expect(state.nodeRuns.design?.awaitingApproval).toBe("artifacts/design.md");
  });

  test("a plain comment on the waiting file leaves the node waiting", () => {
    const state = project([...waitingOnTwoFiles, commentAdded(6, "comment", "artifacts/plan.md")]);
    expect(state.nodeRuns.fix?.nodes?.planning?.awaitingApproval).toBe("artifacts/plan.md");
  });
});

const SHA = "3f2c9ab41d0e8c7b6a5f4e3d2c1b0a9f8e7d6c5b";

const repository = (worktreeDir: string, overrides: Record<string, string> = {}) => ({
  name: "api",
  worktreeDir,
  checkoutDir: "/meta/api",
  baseBranch: "main",
  startSha: SHA,
  ...overrides,
});

const createdPayload = (
  layout: "mono" | "multi",
  repositories: Record<string, ReturnType<typeof repository>>,
) => ({ layout, branch: "feat-x", workspaceDir: "/meta/.workspaces/feat-x", repositories });

describe("workspace event schemas", () => {
  const issuePaths = (payload: unknown): string[] => {
    const parsed = WorkspaceCreatedEvent.safeParse({ payload });
    return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join("."));
  };

  test("WS40 — a mono workspace.created with two repositories fails", () => {
    const dir = "/meta/.workspaces/feat-x";
    const payload = createdPayload("mono", { api: repository(dir), web: repository(dir) });
    expect(issuePaths(payload)).toContain("payload.repositories");
  });
});

const SHA_B = "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d";
const WS_DIR = "/meta/.workspaces/feat-x";

const workspaceEvent = (seq: number, type: string, payload: JsonValue): Event => ({
  schemaVersion: 1,
  seq,
  id: `ws-${seq}`,
  ts: `2026-09-26T11:00:0${seq}Z`,
  type,
  source: "orchestrate",
  runId: "r-1",
  payload,
});

const workspaceHistory: readonly Event[] = [
  workspaceEvent(
    1,
    "workspace.created",
    createdPayload("multi", {
      api: repository(`${WS_DIR}/api`),
      web: repository(`${WS_DIR}/web`, { name: "web", checkoutDir: "/meta/web" }),
    }),
  ),
  workspaceEvent(2, "workspace.repository.removed", {
    workspaceDir: WS_DIR,
    branch: "feat-x",
    repoId: "web",
    name: "web",
    worktreeDir: `${WS_DIR}/web`,
  }),
  workspaceEvent(3, "workspace.repository.added", {
    workspaceDir: WS_DIR,
    branch: "feat-x",
    repoId: "docs",
    repository: repository(`${WS_DIR}/docs`, {
      name: "docs",
      checkoutDir: "/meta/docs",
      startSha: SHA_B,
    }),
  }),
];

describe("workspace reducers", () => {
  test("WS41 — created, then web removed, then docs added: the workspace points at workspaceDir and holds exactly api and docs", () => {
    const state = project(workspaceHistory);
    expect(state.workspace).toEqual({
      type: "multi",
      path: WS_DIR,
      repositories: {
        api: {
          path: `${WS_DIR}/api`,
          git: { branch: "feat-x", baseBranch: "main", startSha: SHA },
        },
        docs: {
          path: `${WS_DIR}/docs`,
          git: { branch: "feat-x", baseBranch: "main", startSha: SHA_B },
        },
      },
    });
  });

  test("WS42 — workspace.removed and workspace.create-failed leave state.workspace unchanged", () => {
    const before = project(workspaceHistory).workspace;
    const after = project([
      ...workspaceHistory,
      workspaceEvent(4, "workspace.removed", {
        workspaceDir: WS_DIR,
        branch: "feat-x",
        repositories: ["api", "docs"],
      }),
      workspaceEvent(5, "workspace.create-failed", {
        workspaceDir: WS_DIR,
        branch: "feat-x",
        errors: [{ repoId: "api", kind: "setup", message: "setup failed with exit code 1" }],
      }),
    ]);
    expect(after.workspace).toEqual(before);
    expect(after.lastEventSeq).toBe(5);
  });
});

describe("hooks.stop.called", () => {
  const called = {
    agent: "claude",
    sessionId: "s1",
    touchedRun: null,
    decision: "continue",
    reason: "node-not-done",
    blockStreak: 1,
    message: "m",
  };

  test("SC14 — a stop-called event records its block streak and seq in state", () => {
    const state = project([
      {
        schemaVersion: 1,
        seq: 7,
        id: "evt-7",
        ts: "2026-09-26T10:00:07Z",
        type: "hooks.stop.called",
        source: "hooks",
        runId: "r-1",
        payload: called,
      },
    ]);
    expect(state.stopHook).toEqual({ blockStreak: 1, seq: 7 });
  });
});

describe("hooks.pre-tool-use.called", () => {
  const event = (seq: number, type: string, payload: JsonValue) => ({
    schemaVersion: 1 as const,
    seq,
    id: `evt-${seq}`,
    ts: "2026-09-26T10:00:07Z",
    type,
    source: "hooks",
    runId: "r-1",
    payload,
  });
  const stop = event(5, "hooks.stop.called", {
    agent: "claude",
    sessionId: "s1",
    touchedRun: null,
    decision: "continue",
    reason: "node-not-done",
    blockStreak: 1,
  });
  const tool = (seq: number) =>
    event(seq, "hooks.pre-tool-use.called", {
      agent: "claude",
      sessionId: "s1",
      tool: "Bash",
      decision: "allow",
    });

  test("SC13 — a tool-call event leaves the Stop hook's last check as it was", () => {
    expect(project([stop, tool(6)]).stopHook).toEqual({ blockStreak: 1, seq: 5 });
  });
});

describe("blocker", () => {
  const design = { nodeId: "design", nodeRunId: "design-1" };
  const at = (seq: number) => `2026-09-26T10:01:${String(seq).padStart(2, "0")}Z`;
  const runEvent = (seq: number, type: string, payload: JsonValue, ids = {}): Event => ({
    schemaVersion: 1,
    seq,
    id: `evt-${seq}`,
    ts: at(seq),
    type,
    source: "hooks",
    runId: "r-1",
    ...ids,
    payload,
  });
  const session = { agent: "claude", sessionId: "s1" };
  const designRunning = runEvent(1, "workflow.node.started", { nodeType: "agent" }, design);
  const question = { question: "Ship the plan as is?", options: ["Approve", "Revise"] };
  const resumeAt = "2026-09-26T14:00:00Z";
  const asked = (seq: number) =>
    runEvent(seq, "agent.question.asked", { ...session, questions: [question] });
  const answered = (seq: number) =>
    runEvent(seq, "agent.question.answered", {
      ...session,
      answers: [{ question: question.question, answer: "Approve" }],
    });
  const limitWaiting = (seq: number) =>
    runEvent(seq, "agent.limit.waiting", {
      sessionId: "s1",
      limitEventId: "evt-0",
      resumeAt,
      from: "message",
    });
  const limitResumed = (seq: number) =>
    runEvent(seq, "agent.limit.resumed", { sessionId: "s1", limitEventId: "evt-0" });
  const stopCalled = (seq: number) =>
    runEvent(seq, "hooks.stop.called", {
      ...session,
      touchedRun: null,
      decision: "continue",
      reason: "node-not-done",
      blockStreak: 1,
    });
  const unblockedState = (state: State) => {
    expect(state.status).toBe("running");
    expect(state).not.toHaveProperty("blocker");
  };

  test("SC126: a question blocks the running design step with the questions asked, and its answer unblocks it", () => {
    const opened = [
      designRunning,
      asked(2),
      runEvent(3, "hooks.pre-tool-use.called", {
        ...session,
        tool: "AskUserQuestion",
        decision: "allow",
      }),
      runEvent(4, "subscriber.called", {
        subscriber: "notify",
        eventId: "evt-2",
        eventSeq: 2,
        eventType: "agent.question.asked",
        blocking: false,
        status: "ok",
        durationMs: 3,
      }),
    ];

    const blocked = project(opened);
    expect(blocked.status).toBe("blocked");
    expect(blocked.blocker).toEqual({
      reason: "question",
      node: "design",
      since: at(2),
      details: { questions: [question] },
    });
    unblockedState(project([...opened, answered(5)]));
  });

  const stuck = (seq: number, message?: string) =>
    runEvent(seq, "agent.stuck", { ...session, ...(message === undefined ? {} : { message }) });
  const toolCalled = (seq: number, tool: string) =>
    runEvent(seq, "hooks.pre-tool-use.called", {
      ...session,
      tool,
      handler: "record-guard",
      decision: "allow",
    });
  const inputUnreachable = (seq: number) =>
    runEvent(seq, "agent.input.unreachable", {
      ...session,
      step: "design",
      line: "/yok:orchestrate --resume r",
    });
  const onDesign = { node: "design", since: at(2) };
  const openings: readonly (readonly [string, Event, Blocker])[] = [
    [
      "agent.question.asked",
      asked(2),
      { ...onDesign, reason: "question", details: { questions: [question] } },
    ],
    [
      "agent.limit.waiting",
      limitWaiting(2),
      { ...onDesign, reason: "usage-limit", details: { resumeAt } },
    ],
    [
      "agent.stuck with a message",
      stuck(2, "sent back 5 times"),
      { ...onDesign, reason: "stuck", details: { message: "sent back 5 times" } },
    ],
    [
      "agent.stuck without a message",
      stuck(2),
      { ...onDesign, reason: "stuck", details: { message: null } },
    ],
    [
      "agent.stopped",
      runEvent(2, "agent.stopped", {
        ...session,
        error: "authentication_failed",
        message: "Invalid API key",
      }),
      {
        ...onDesign,
        reason: "agent-error",
        details: { error: "authentication_failed", message: "Invalid API key" },
      },
    ],
  ];
  // Tool calls and step moves only log what happened; only the blocker's own closing event,
  // agent.resumed, or the workflow ending clears it.
  const nonClosing: readonly (readonly [string, Event])[] = [
    [
      "workflow.node.completed",
      runEvent(3, "workflow.node.completed", { nodeType: "agent", attempts: 1 }, design),
    ],
    [
      "orchestrate.done",
      runEvent(3, "orchestrate.done", {
        input: { nodeRunId: "design-1", artifacts: [], output: "done" },
        output: { kind: "error", message: "boom" },
        status: "error",
      }),
    ],
    [
      "orchestrate.exec",
      runEvent(3, "orchestrate.exec", {
        input: { nodeRunId: "design-1" },
        output: { kind: "error", message: "boom" },
      }),
    ],
    ["a Bash hooks.pre-tool-use.called", toolCalled(3, "Bash")],
    ["orchestrate.next", runEvent(3, "orchestrate.next", { input: {}, output: { kind: "wait" } })],
    ["hooks.stop.called", stopCalled(3)],
    ["an AskUserQuestion hooks.pre-tool-use.called", toolCalled(3, "AskUserQuestion")],
  ];
  test.each(openings)(
    "SC127: %s blocks the running run with its own reason and details",
    (_name, opening, expected) => {
      const state = project([designRunning, opening]);
      expect(state.status).toBe("blocked");
      expect(state.blocker).toEqual(expected);
    },
  );

  const rotated = nonClosing.flatMap(([next, event], index) => {
    const opening = openings[index % openings.length];
    return opening === undefined ? [] : [[opening[0], next, opening[1], event] as const];
  });

  test.each(rotated)(
    "SC127: %s then %s leaves the run blocked with the same blocker",
    (_name, _next, opening, event) => {
      const before = project([designRunning, opening]);
      const after = project([designRunning, opening, event]);
      expect(after.status).toBe("blocked");
      expect(after.blocker).toEqual(before.blocker);
    },
  );

  const resumed = (seq: number, reason: string) =>
    runEvent(seq, "agent.resumed", { ...session, reason, tool: "Bash" });

  test.each(openings)(
    "SC142: %s then agent.resumed with its own reason puts the run back to running with no blocker",
    (_name, opening, expected) => {
      unblockedState(project([designRunning, opening, resumed(3, expected.reason)]));
    },
  );

  test.each(openings)(
    "SC142: %s then agent.resumed with another reason leaves the run blocked with the same blocker",
    (_name, opening, expected) => {
      const other = expected.reason === "question" ? "usage-limit" : "question";
      const state = project([designRunning, opening, resumed(3, other)]);
      expect(state.status).toBe("blocked");
      expect(state.blocker).toEqual(expected);
    },
  );

  test("SC16: an unreachable input box leaves the run running with no blocker; only the notifier tells a person", () => {
    unblockedState(project([designRunning, inputUnreachable(2)]));
  });

  test("an input box yok could not reach leaves the run running with no blocker; only the notifier tells a person", () => {
    const unreachable = runEvent(2, "agent.input.unreachable", {
      ...session,
      step: "design",
      line: "/yok:orchestrate --resume r",
    });
    unblockedState(project([designRunning, unreachable]));
  });

  test("SC142: agent.resumed on a running run leaves it running with no blocker", () => {
    unblockedState(project([designRunning, resumed(2, "usage-limit")]));
  });

  test("SC127: a question asked inside qa-loop names the running leaf qa-loop.qa as its node", () => {
    const loopStarted = runEvent(
      1,
      "workflow.node.started",
      { nodeType: "loop" },
      { nodeId: "qa-loop", nodeRunId: "qa-loop-1" },
    );
    const qaStarted = runEvent(
      2,
      "workflow.node.started",
      { nodeType: "agent", parents: ["qa-loop"] },
      { nodeId: "qa", nodeRunId: "qa-1" },
    );
    expect(project([loopStarted, qaStarted, asked(3)]).blocker?.node).toBe("qa-loop.qa");
  });

  test("SC128: agent.limit.resumed clears a usage-limit blocker", () => {
    unblockedState(project([designRunning, limitWaiting(2), limitResumed(3)]));
  });

  test("SC128: a question blocker survives agent.limit.resumed, and a newer question replaces a usage-limit blocker", () => {
    expect(project([designRunning, asked(2), limitResumed(3)]).blocker).toMatchObject({
      reason: "question",
      since: at(2),
    });
    expect(project([designRunning, limitWaiting(2), asked(3)]).blocker).toMatchObject({
      reason: "question",
      since: at(3),
    });
  });

  test("SC129: agent.stuck after the run completed changes nothing, and workflow.failed on a blocked run drops its blocker", () => {
    const completed = project([designRunning, runEvent(2, "workflow.completed", {}), stuck(3)]);
    expect(completed.status).toBe("completed");
    expect(completed).not.toHaveProperty("blocker");

    const failed = project([designRunning, asked(2), runEvent(3, "workflow.failed", {})]);
    expect(failed.status).toBe("failed");
    expect(failed).not.toHaveProperty("blocker");
  });
});

describe("emitEvent refusals", () => {
  const node = { nodeId: "a", nodeRunId: "a" };
  const session = { agent: "claude", sessionId: "s1" };
  const doneInput = { nodeRunId: "nr-1", output: {}, artifacts: [] };
  const doneOutput = { nodeRunId: "nr-1", nodeId: "a", status: "completed", attempts: 1 };
  const exit = { kind: "exit", message: "exit 1" };
  const whenFalse = { reason: "when-false", proof: { expression: "{{ false }}", value: false } };
  const workspace = { workspaceDir: "/meta/.workspaces/feat-x", branch: "feat-x" };

  test.each([
    [
      "workflow.started without a workflow name",
      "workflow.started",
      {},
      { inputs: {} },
      "workflow.started",
    ],
    [
      "SC3: workflow.node.failed without an error",
      "workflow.node.failed",
      node,
      { nodeType: "exec", attempts: 1 },
      "workflow.node.failed",
    ],
    [
      "SC4: workflow.node.started without node ids",
      "workflow.node.started",
      {},
      { nodeType: "exec" },
      "nodeId",
    ],
    [
      "workflow.node.skipped without a skip reason",
      "workflow.node.skipped",
      node,
      { nodeType: "exec", attempts: 0 },
      "skip",
    ],
    [
      "workflow.node.failed with an output",
      "workflow.node.failed",
      node,
      { nodeType: "exec", attempts: 1, output: "hi", error: exit },
      "workflow.node.failed",
    ],
    [
      "workflow.node.cancelled with an output",
      "workflow.node.cancelled",
      node,
      { nodeType: "exec", attempts: 1, output: "hi" },
      "workflow.node.cancelled",
    ],
    [
      "workflow.node.skipped with an output",
      "workflow.node.skipped",
      node,
      { nodeType: "exec", attempts: 1, output: "hi", skip: whenFalse },
      "workflow.node.skipped",
    ],
    [
      "workflow.node.failed with a skip",
      "workflow.node.failed",
      node,
      { nodeType: "exec", attempts: 1, skip: whenFalse, error: exit },
      "workflow.node.failed",
    ],
    [
      "workflow.node.cancelled with a skip",
      "workflow.node.cancelled",
      node,
      { nodeType: "exec", attempts: 1, skip: whenFalse },
      "workflow.node.cancelled",
    ],
    [
      "workflow.node.completed with an error beside its output",
      "workflow.node.completed",
      node,
      { nodeType: "exec", attempts: 1, output: "hi", error: exit },
      "workflow.node.completed",
    ],
    [
      "workflow.node.completed with a skip beside its output",
      "workflow.node.completed",
      node,
      { nodeType: "exec", attempts: 1, output: "hi", skip: whenFalse },
      "workflow.node.completed",
    ],
    [
      "orchestrate.exec without its input",
      "orchestrate.exec",
      {},
      { output: { kind: "error", message: "x" } },
      "orchestrate.exec",
    ],
    [
      "orchestrate.verifier without its verifier",
      "orchestrate.verifier",
      {},
      { attempt: 1, durationMs: 3, status: "passed", findings: [] },
      "orchestrate.verifier",
    ],
    [
      "orchestrate.done with a report missing its status",
      "orchestrate.done",
      {},
      { input: doneInput, output: { nodeRunId: "nr-1", nodeId: "a", attempts: 1 } },
      "orchestrate.done",
    ],
    [
      "orchestrate.done without a status",
      "orchestrate.done",
      {},
      { input: doneInput, output: doneOutput },
      "orchestrate.done",
    ],
    [
      "orchestrate.done with an unknown status",
      "orchestrate.done",
      {},
      { input: doneInput, output: doneOutput, status: "refused" },
      "orchestrate.done",
    ],
    [
      "orchestrate.done with neither an output nor an error",
      "orchestrate.done",
      {},
      { input: { nodeRunId: "nr-1", artifacts: [] }, output: doneOutput },
      "orchestrate.done",
    ],
    [
      "orchestrate.done with both an output and an error",
      "orchestrate.done",
      {},
      { input: { ...doneInput, error: "no" }, output: doneOutput },
      "orchestrate.done",
    ],
    [
      "WS24: workspace.created with a short startSha",
      "workspace.created",
      {},
      createdPayload("multi", {
        api: repository("/meta/.workspaces/feat-x/api", { startSha: "abc" }),
      }),
      "startSha",
    ],
    [
      "WS24: workspace.repository.added with no repoId",
      "workspace.repository.added",
      {},
      { ...workspace, repository: repository("/meta/.workspaces/feat-x/api") },
      "repoId",
    ],
    [
      "workspace.create-failed with an error naming no repoId",
      "workspace.create-failed",
      {},
      { ...workspace, errors: [{ kind: "setup", message: "broke" }] },
      "repoId",
    ],
    [
      "workspace.remove-failed with an error naming no repoId",
      "workspace.remove-failed",
      {},
      { ...workspace, errors: [{ kind: "setup", message: "broke" }] },
      "repoId",
    ],
    [
      "SC14: hooks.stop.called with an unknown decision",
      "hooks.stop.called",
      {},
      {
        ...session,
        touchedRun: null,
        decision: "maybe",
        reason: "node-not-done",
        blockStreak: 1,
        message: "m",
      },
      "hooks.stop.called",
    ],
    [
      "SC142: agent.resumed with a reason that is not a blocker reason",
      "agent.resumed",
      {},
      { ...session, reason: "progress", tool: "Bash" },
      "agent.resumed",
    ],
    [
      "agent.limit.reached with a bad payload",
      "agent.limit.reached",
      {},
      session,
      "agent.limit.reached",
    ],
    [
      "agent.limit.waiting with a bad payload",
      "agent.limit.waiting",
      {},
      { sessionId: "s1", limitEventId: "e-1", resumeAt: "soon" },
      "agent.limit.waiting",
    ],
    [
      "agent.limit.resumed with a bad payload",
      "agent.limit.resumed",
      {},
      { sessionId: "s1" },
      "agent.limit.resumed",
    ],
    [
      "agent.input.unreachable with no step",
      "agent.input.unreachable",
      {},
      { ...session, line: "/yok:orchestrate --resume r" },
      "agent.input.unreachable",
    ],
    [
      "agent.input.unreachable with no line",
      "agent.input.unreachable",
      {},
      { ...session, step: "design" },
      "agent.input.unreachable",
    ],
  ])(
    "%s is refused, naming why, and nothing is stored",
    async (_label, type, ids, payload, reason) => {
      const store = memoryEventStore();
      const result = await emitEvent(store, "r-1", { type, source: "test", ...ids, payload });
      expect(result.ok ? "" : result.error).toContain(reason);
      expect(await store.read()).toEqual([]);
    },
  );
});

describe("findRunningLeaf", () => {
  const nodeRun = (status: NodeRun["status"], extra: Partial<NodeRun> = {}): NodeRun => ({
    nodeRunId: "n",
    nodeType: "exec",
    status,
    startedAt: null,
    completedAt: null,
    artifacts: [],
    ...extra,
  });
  const qa = nodeRun("running", { nodeRunId: "qa" });

  test.each([
    {
      given: "qa-loop running qa",
      nodes: { plan: nodeRun("completed"), "qa-loop": nodeRun("running", { nodes: { qa } }) },
      found: { path: "qa-loop.qa", run: qa },
    },
    {
      given: "qa-loop running with no running child",
      nodes: { "qa-loop": nodeRun("running", { nodeRunId: "loop", nodes: {} }) },
      found: { path: "qa-loop", run: nodeRun("running", { nodeRunId: "loop", nodes: {} }) },
    },
    { given: "no running node", nodes: { plan: nodeRun("completed") }, found: undefined },
  ])("SC113: the running leaf of $given is the deepest running node", ({ nodes, found }) => {
    expect(findRunningLeaf(nodes)).toEqual(found);
  });

  const review = nodeRun("running", { nodeRunId: "review", nodeType: "agent", mode: "subagent" });
  const write = nodeRun("running", { nodeRunId: "write", nodeType: "agent", mode: "inline" });
  const loop = nodeRun("running", { nodeRunId: "loop", nodeType: "loop", nodes: {} });
  const lint = nodeRun("running", { nodeRunId: "lint" });
  test.each([
    {
      given: "review (subagent) listed before write (inline)",
      nodes: { review, write },
      found: { path: "write", run: write },
    },
    { given: "only review running", nodes: { review }, found: { path: "review", run: review } },
    {
      given: "a loop with nothing inside running",
      nodes: { loop },
      found: { path: "loop", run: loop },
    },
    {
      given: "exec lint listed before review (subagent)",
      nodes: { lint, review },
      found: { path: "review", run: review },
    },
    {
      given: "a loop with nothing inside running listed before review (subagent)",
      nodes: { loop, review },
      found: { path: "review", run: review },
    },
    {
      given: "a loop with nothing inside running listed before exec lint",
      nodes: { loop, lint },
      found: { path: "lint", run: lint },
    },
  ])(
    "SC18: with $given, the running step is the session's inline node, else an agent node, else the first running one",
    ({ nodes, found }) => {
      expect(findRunningLeaf(nodes)).toEqual(found);
    },
  );
});

describe("foldModelSwitch", () => {
  const LAUNCH = { model: "opus-x", effort: "high" } as const;
  const event = (seq: number, type: string, payload: JsonValue, ids = {}): Event => ({
    schemaVersion: 1,
    seq,
    id: `evt-${seq}`,
    ts: "2026-09-26T10:00:00Z",
    type,
    source: "test",
    runId: "r-1",
    ...ids,
    payload,
  });
  const requested = (seq: number, node = "loop.think") =>
    event(seq, "workflow.model.requested", { node, model: "sonnet-x" });
  const applied = (seq: number, requestSeq: number, result: object) =>
    event(seq, "workflow.model.applied", {
      requestSeq,
      node: "loop.think",
      model: "sonnet-x",
      ...result,
    });
  const thinkFailed = (seq: number, parents: readonly string[]) =>
    event(
      seq,
      "workflow.node.failed",
      {
        nodeType: "agent",
        parents: [...parents],
        attempts: 0,
        error: { kind: "exception", message: "x" },
      },
      { nodeId: "think", nodeRunId: `nr-${seq}` },
    );
  const NONE = { current: LAUNCH, pending: null, failed: null };

  test.each([
    ["no model events leave the session on the default tier's model", [], NONE],
    [
      "a request opens a pending switch with its seq",
      [requested(3)],
      { ...NONE, pending: { seq: 3, node: "loop.think", model: "sonnet-x" } },
    ],
    [
      "an applied: true answering seq 3 moves the session to sonnet-x and closes the request",
      [requested(3), applied(4, 3, { applied: true })],
      { ...NONE, current: { model: "sonnet-x" } },
    ],
    [
      "an applied: false answering seq 3 records the failure for loop.think and closes the request",
      [requested(3), applied(4, 3, { applied: false, reason: "respawn failed" })],
      { ...NONE, failed: { node: "loop.think", reason: "respawn failed" } },
    ],
    [
      "an applied answering an older request seq 2 is ignored and seq 3 stays pending",
      [requested(3), applied(4, 2, { applied: true })],
      { ...NONE, pending: { seq: 3, node: "loop.think", model: "sonnet-x" } },
    ],
    [
      "a failure of loop.think clears the failed switch",
      [
        requested(3),
        applied(4, 3, { applied: false, reason: "respawn failed" }),
        thinkFailed(5, ["loop"]),
      ],
      NONE,
    ],
    [
      "a failure of a think node at another path keeps the failed switch",
      [
        requested(3),
        applied(4, 3, { applied: false, reason: "respawn failed" }),
        thinkFailed(5, []),
      ],
      { ...NONE, failed: { node: "loop.think", reason: "respawn failed" } },
    ],
  ])("%s", (_label, events, expected) => {
    expect(foldModelSwitch(events, { default: "deep", models: { deep: LAUNCH } })).toEqual(
      expected,
    );
  });

  test("a run with no tiers starts on no model", () => {
    expect(foldModelSwitch([], null)).toEqual({ current: null, pending: null, failed: null });
  });
});
