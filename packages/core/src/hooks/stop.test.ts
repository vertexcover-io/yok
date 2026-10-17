import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sdk from "@yok/sdk";
import {
  emitRunEvent,
  type NodeRun,
  noopLogger,
  type RunRef,
  readState,
  registryPath,
  runDirOf,
  type State,
  type StopInput,
  type TranscriptEntry,
} from "@yok/sdk";
import { appendRunEvent, createRegistry, jsonlEventStore } from "@yok/sdk/internal";
import { orchestrateArgv } from "../stage.ts";
import { recordGuard, runPreToolUse } from "./pre-tool-use.ts";
import { decideStop, runStopHook, type StopCheck } from "./stop.ts";

const seed: State = {
  schemaVersion: 1,
  lastEventSeq: 0,
  runId: "r-1",
  runName: "feat-x",
  runDir: "/repo/.yok/feat-x",
  version: "2.0.0",
  workflow: { name: "feature", path: "workflow.yaml" },
  input: {},
  scope: null,
  startedAt: "2026-09-26T10:00:00Z",
  completedAt: null,
  status: "running",
  workspace: {
    type: "mono",
    path: "/repo",
    repositories: {
      app: { path: "/repo", git: { branch: "b", baseBranch: "main", startSha: "a" } },
    },
  },
  nodeRuns: {},
  activeSessions: [],
  tiers: null,
  eventHandlers: {},
  subscribers: {},
};

const RUN: RunRef = { id: "r-1", cwd: "/repo", name: "feat-x" };

const nodeRun = (
  nodeRunId: string,
  status: NodeRun["status"],
  nodeType: NodeRun["nodeType"] = "agent",
  nodes?: Record<string, NodeRun>,
): NodeRun => ({
  nodeRunId,
  nodeType,
  status,
  startedAt: "2026-09-26T10:00:00Z",
  completedAt: status === "running" ? null : "2026-09-26T10:01:00Z",
  artifacts: [],
  ...(nodes === undefined ? {} : { nodes }),
});

const planOpen = { plan: nodeRun("plan", "running") };
const UNATTENDED = { values: { interaction: false }, sources: { interaction: "cli" } } as const;

const decide = (overrides: Partial<State>, check: Partial<Omit<StopCheck, "run" | "state">> = {}) =>
  decideStop({
    run: RUN,
    state: { ...seed, ...overrides },
    touchedRun: true,
    progressSinceCheck: false,
    maxBlocks: 1,
    waitingOnBackground: false,
    pendingSwitch: null,
    ...check,
  });

describe("decideStop", () => {
  test("SC1 — a finished run lets the turn end", () => {
    const decision = decide({ status: "completed", nodeRuns: planOpen });
    expect(decision).toMatchObject({ reason: "run-finished" });
  });

  test("SC134: a run blocked with design open sends the agent back to finish design, as a running run does", () => {
    const design = { design: nodeRun("design-1", "running") };
    const blocker = {
      reason: "stuck",
      node: "design",
      since: "2026-09-26T10:05:00Z",
      details: { message: null },
    } as const;
    const decision = decide({ status: "blocked", blocker, nodeRuns: design });
    expect(decision).toMatchObject({ reason: "node-not-done", nodeRunId: "design-1" });
    expect(decision).toEqual(decide({ nodeRuns: design }));
  });

  test("SC2, SC23 — an open leaf inside a loop blocks with that leaf's done command", () => {
    const loop = nodeRun("fix", "running", "loop", { review: nodeRun("fix/1/review", "running") });
    const decision = decide({ nodeRuns: { fix: loop } });
    expect(decision).toMatchObject({
      reason: "node-not-done",
      blockStreak: 1,
      nodeRunId: "fix/1/review",
    });
    const message = "message" in decision ? decision.message : "";
    expect(message).toContain("node review");
    expect(message).toContain("yok orchestrate done fix/1/review --run feat-x");
    expect(message).not.toContain("bun run");
  });

  test("SC3 — a running loop with no running child blocks with the next command", () => {
    const loop = nodeRun("fix", "running", "loop", {
      review: nodeRun("fix/1/review", "completed"),
    });
    const decision = decide({ nodeRuns: { fix: loop } });
    expect(decision).toMatchObject({
      message: expect.stringContaining("yok orchestrate next --run feat-x"),
      reason: "next-not-run",
    });
  });

  test("an open exec node is sent back with its exec command, never done", () => {
    const decision = decide({ nodeRuns: { lint: nodeRun("lint", "running", "exec") } });
    const message = "message" in decision ? decision.message : "";
    expect(decision).toMatchObject({ reason: "node-not-done", nodeRunId: "lint" });
    expect(message).toContain("yok orchestrate exec lint --run feat-x");
    expect(message).toContain("background task");
    expect(message).not.toContain("orchestrate done");
  });

  test.each([
    ["SC4 — a chat turn between nodes lets the turn end", false, { reason: "user-chat" }],
    [
      "SC5 — an unknown turn between nodes still blocks",
      undefined,
      {
        reason: "next-not-run",
        message: expect.stringContaining("yok orchestrate next --run feat-x"),
      },
    ],
    [
      "SC10 — a run-work turn between nodes with no switch pending, as after a failed one, is sent to next",
      true,
      {
        reason: "next-not-run",
        message: expect.stringContaining("yok orchestrate next --run feat-x"),
      },
    ],
  ])("%s", (_label, touchedRun, expected) => {
    expect(decide({}, { touchedRun })).toMatchObject(expected);
  });

  test("SC522: with interaction off and an agent node open, a first stop is sent back with the policy's message, and one at maxBlocks is unanswered-stop, not max-blocks-reached", () => {
    const first = decide({ nodeRuns: planOpen, policies: UNATTENDED });
    const atMax = decide({
      nodeRuns: planOpen,
      policies: UNATTENDED,
      stopHook: { blockStreak: 1, seq: 12 },
      lastEventSeq: 12,
    });

    expect(first).toMatchObject({
      reason: "node-not-done",
      blockStreak: 1,
      nodeRunId: "plan",
      message: expect.stringContaining("No one will answer in this run."),
    });
    expect(atMax).toMatchObject({ reason: "unanswered-stop", blockStreak: 2, nodeRunId: "plan" });
  });

  test("SC6 — a chat turn with a node open still blocks", () => {
    const decision = decide({ nodeRuns: planOpen }, { touchedRun: false });
    expect(decision).toMatchObject({
      message: expect.stringContaining("orchestrate done plan"),
      reason: "node-not-done",
    });
  });

  test("SC7 — a second stop with no new event lets the turn end", () => {
    const decision = decide({
      nodeRuns: planOpen,
      stopHook: { blockStreak: 1, seq: 12 },
      lastEventSeq: 12,
    });
    expect(decision).toMatchObject({ reason: "max-blocks-reached", blockStreak: 1 });
  });

  test("SC8 — progress since the last stop check restarts the count", () => {
    const decision = decide(
      { nodeRuns: planOpen, stopHook: { blockStreak: 1, seq: 12 }, lastEventSeq: 14 },
      { progressSinceCheck: true },
    );
    expect(decision).toMatchObject({ reason: "node-not-done", blockStreak: 1 });
  });

  test("SC9 — an allowed call keeps the streak it found", () => {
    const decision = decide(
      { stopHook: { blockStreak: 1, seq: 12 }, lastEventSeq: 12 },
      { touchedRun: false },
    );
    expect(decision).toMatchObject({ reason: "user-chat", blockStreak: 1 });
  });

  test("SC3: a stop while the open agent node waits for approval of artifacts/design.md lets the turn end as awaiting-approval, even at block streak 1", () => {
    const design = { ...nodeRun("design", "running"), awaitingApproval: "artifacts/design.md" };
    const decision = decide({
      nodeRuns: { design },
      stopHook: { blockStreak: 1, seq: 12 },
      lastEventSeq: 12,
    });
    expect(decision).toEqual({ reason: "awaiting-approval", blockStreak: 1, nodeRunId: "design" });
  });

  test("SC9: a stop between nodes with switch seq 42 pending lets the turn end as model-switch, even on a chat turn", () => {
    const pending = { seq: 42, node: "think", model: "opus-x" };
    expect(decide({}, { touchedRun: false, pendingSwitch: pending })).toEqual({
      reason: "model-switch",
      blockStreak: 0,
      seq: 42,
    });
  });

  test("a stop with a context node open while a background task runs still lets the turn end as context-node", () => {
    const decision = decide(
      { nodeRuns: { compact: nodeRun("compact", "running", "context") } },
      { waitingOnBackground: true },
    );
    expect(decision).toEqual({ reason: "context-node", blockStreak: 0, nodeRunId: "compact" });
  });

  test("a stop at streak 1 with no progress while a background task runs ends as background-task and keeps streak 1", () => {
    const decision = decide(
      { nodeRuns: planOpen, stopHook: { blockStreak: 1, seq: 12 }, lastEventSeq: 12 },
      { waitingOnBackground: true },
    );
    expect(decision).toEqual({ reason: "background-task", blockStreak: 1 });
  });
});

const setUp = async (
  nodeRuns: State["nodeRuns"],
  agent: "claude" | "codex" = "claude",
  overrides: Partial<State> = {},
) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "hooks-home-")));
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "hooks-repo-")));
  const registry = createRegistry(registryPath(home));
  await registry.addRun({
    id: "r-1",
    workflow: "feature",
    workflowPath: join(cwd, "workflow.yaml"),
    inputs: {},
    cwd,
    sessions: [{ agent, sessionId: "s1" }],
    name: "feat-x",
    terminal: null,
    config: null,
    tiers: null,
    createdAt: "2026-09-26T10:00:00Z",
  });
  const runDir = runDirOf(cwd, "feat-x");
  await mkdir(runDir, { recursive: true });
  const config = { path: null, root: cwd };
  await writeFile(
    join(runDir, "state.json"),
    JSON.stringify({ ...seed, ...overrides, nodeRuns, config }),
  );
  return { runDir, cwd, deps: { registry, env: { YOK_RUN_ID: "r-1" }, log: noopLogger } };
};

const input = (
  entries: readonly TranscriptEntry[] | undefined,
  agent: "claude" | "codex" = "claude",
  waitingOnBackground = false,
): StopInput => ({
  agent,
  sessionId: "s1",
  contextSteps: agent === "claude",
  waitingOnBackground,
  readTranscript: async () => entries,
});

const orchestrateAfterPrompt: TranscriptEntry[] = [
  { kind: "prompt", text: "why?" },
  { kind: "command", command: "ls" },
  { kind: "prompt", text: "go" },
  { kind: "command", command: "yok orchestrate next --run feat-x" },
];

describe("runStopHook", () => {
  test("SC10 — YOK_STOP_MAX_BLOCKS sets how many blocks in a row, and a bad value keeps the default of 1", async () => {
    const replies = async (maxBlocks: string | undefined) => {
      const { deps } = await setUp(planOpen);
      const env = { ...deps.env, YOK_STOP_MAX_BLOCKS: maxBlocks };
      const kinds: string[] = [];
      for (const _ of [1, 2, 3, 4]) {
        kinds.push((await runStopHook(input(undefined), { ...deps, env })).kind);
      }
      return kinds;
    };
    expect(await replies("3")).toEqual(["continue", "continue", "continue", "allow"]);
    expect(await replies("0")).toEqual(["continue", "allow", "allow", "allow"]);
    expect(await replies("abc")).toEqual(["continue", "allow", "allow", "allow"]);
    expect(await replies(undefined)).toEqual(["continue", "allow", "allow", "allow"]);
  });

  test.each<[string, readonly TranscriptEntry[] | undefined, "continue" | "allow"]>([
    ["SC11, SC24 — yok orchestrate next after the last prompt", orchestrateAfterPrompt, "continue"],
    [
      "SC24 — yok orchestrate run-subscriber call after the prompt",
      [
        { kind: "prompt", text: "go" },
        { kind: "command", command: "yok orchestrate run-subscriber call" },
      ],
      "allow",
    ],
    [
      "SC316 — yok orchestrate resume after the prompt",
      [
        { kind: "prompt", text: "/yok:orchestrate --resume feat-x" },
        { kind: "command", command: "yok orchestrate resume --run feat-x" },
      ],
      "continue",
    ],
    [
      "SC12 — orchestrate commands only before the last prompt",
      [
        { kind: "prompt", text: "go" },
        { kind: "command", command: "yok orchestrate next --run feat-x" },
        { kind: "prompt", text: "why did lint fail?" },
        { kind: "command", command: "cat lint.log" },
      ],
      "allow",
    ],
    [
      "reading or grepping orchestrate files",
      [
        { kind: "prompt", text: "how does next work?" },
        { kind: "command", command: "grep -n decideNext packages/core/src/orchestrate.ts" },
        { kind: "command", command: "cat skills/orchestrate/SKILL.md" },
        { kind: "command", command: "grep -rn orchestrate packages/core" },
      ],
      "allow",
    ],
    [
      "a direct call to the orchestrate script",
      [
        { kind: "prompt", text: "go" },
        {
          kind: "command",
          command: "bun /h/packages/core/src/orchestrate.ts done n1 --run feat-x",
        },
      ],
      "continue",
    ],
    ["SC13 — commands with no prompt", [{ kind: "command", command: "ls" }], "continue"],
    ["SC13 — no transcript", undefined, "continue"],
  ])("between nodes, %s gives %s", async (_label, entries, kind) => {
    const { deps } = await setUp({});
    expect(await runStopHook(input(entries), deps)).toMatchObject({ kind });
  });

  test("the transcript is read only when no node is open, and every call is logged", async () => {
    const { deps, runDir } = await setUp(planOpen);
    let reads = 0;
    const counted: StopInput = {
      ...input(orchestrateAfterPrompt),
      readTranscript: async () => {
        reads += 1;
        return orchestrateAfterPrompt;
      },
    };
    await runStopHook(counted, deps);
    await runStopHook(counted, deps);
    expect(reads).toBe(0);
    const events = await jsonlEventStore(runDir).read();
    expect(events.map((event) => event.payload)).toEqual([
      expect.objectContaining({
        decision: "continue",
        reason: "node-not-done",
        blockStreak: 1,
        touchedRun: null,
      }),
      expect.objectContaining({ decision: "allow", reason: "max-blocks-reached", blockStreak: 1 }),
      { agent: "claude", sessionId: "s1" },
    ]);
    expect((await readState(runDir))?.stopHook).toEqual({ blockStreak: 1, seq: 2 });
  });

  test("a stop that gives up records agent.stuck for the session, which is not progress, so the next stop also lets the turn end", async () => {
    const { deps, runDir } = await setUp(planOpen);

    const kinds = [];
    for (const _ of [1, 2, 3]) kinds.push((await runStopHook(input(undefined), deps)).kind);

    expect(kinds).toEqual(["continue", "allow", "allow"]);
    const stuck = (await jsonlEventStore(runDir).read()).filter((e) => e.type === "agent.stuck");
    expect(stuck.map((event) => [event.source, event.payload])).toEqual([
      ["hooks", { agent: "claude", sessionId: "s1" }],
      ["hooks", { agent: "claude", sessionId: "s1" }],
    ]);
  });

  test("SC137, SC138: two stops with plan open while a background task runs both let the turn end as background-task, at streak 0, with no agent.stuck", async () => {
    const { deps, runDir } = await setUp(planOpen);
    const waiting = input(undefined, "claude", true);

    const kinds = [
      (await runStopHook(waiting, deps)).kind,
      (await runStopHook(waiting, deps)).kind,
    ];

    expect(kinds).toEqual(["allow", "allow"]);
    const events = await jsonlEventStore(runDir).read();
    expect(events.map((event) => [event.type, event.payload])).toEqual([
      ["hooks.stop.called", expect.objectContaining({ reason: "background-task", blockStreak: 0 })],
      ["hooks.stop.called", expect.objectContaining({ reason: "background-task", blockStreak: 0 })],
    ]);
    expect((await readState(runDir))?.status).toBe("running");
  });

  test("a tool call between two stops is not progress, and any other event is", async () => {
    const { deps, runDir } = await setUp(planOpen);
    const cwd = join(runDir, "..", "..");
    const ls = {
      agent: "claude" as const,
      sessionId: "s1",
      toolName: "Bash",
      subagent: false,
      cwd,
    };

    expect(await runStopHook(input(undefined), deps)).toMatchObject({ kind: "continue" });
    await runPreToolUse({ ...ls, call: { kind: "shell", command: "ls" } }, recordGuard, deps);
    expect(await runStopHook(input(undefined), deps)).toEqual({ kind: "allow" });

    const run = { id: "r-1", cwd, name: "feat-x" };
    await emitRunEvent(run, { type: "custom.test.progress", source: "test", payload: {} });
    expect(await runStopHook(input(undefined), deps)).toMatchObject({ kind: "continue" });
  });

  test("with interaction off, any tool call since the last stop is progress, file edits included, so only a stop with no work since fails the node", async () => {
    const { deps, runDir } = await setUp(planOpen, "claude", { policies: UNATTENDED });
    const ran: TranscriptEntry[] = [
      { kind: "prompt", text: "go" },
      { kind: "command", command: "ls" },
    ];
    const edited: TranscriptEntry[] = [
      ...ran,
      { kind: "tool", name: "Write" },
      { kind: "tool", name: "Edit" },
    ];

    await runStopHook(input(ran), deps);
    await runStopHook(input(edited), deps);
    await runStopHook(input(edited), deps);

    const events = await jsonlEventStore(runDir).read();
    const reasons = events.flatMap((event) => {
      const stop = sdk.StopCalledEvent.safeParse(event);
      return stop.success ? [stop.data.payload.reason] : [];
    });
    expect(reasons).toEqual(["node-not-done", "node-not-done", "unanswered-stop"]);
  });

  test("with interaction off, a question tried between stops is not work, so the stop after it still fails the node", async () => {
    const { deps, runDir } = await setUp(planOpen, "claude", { policies: UNATTENDED });
    const ran: TranscriptEntry[] = [
      { kind: "prompt", text: "go" },
      { kind: "command", command: "ls" },
    ];

    await runStopHook(input(ran), deps);
    await runStopHook(input([...ran, { kind: "question" }]), deps);

    const events = await jsonlEventStore(runDir).read();
    const reasons = events.flatMap((event) => {
      const stop = sdk.StopCalledEvent.safeParse(event);
      return stop.success ? [stop.data.payload.reason] : [];
    });
    expect(reasons).toEqual(["node-not-done", "unanswered-stop"]);
  });

  const denied = (handler: string, tool: string) => ({
    type: "hooks.pre-tool-use.called",
    source: "hooks",
    payload: { agent: "claude", sessionId: "s1", tool, handler, decision: "deny", message: "no" },
  });

  test("with interaction off, a tool call yok's guard denied between stops is not work, so the stop after it still fails the node", async () => {
    const { deps, runDir, cwd } = await setUp(planOpen, "claude", { policies: UNATTENDED });
    const ran: TranscriptEntry[] = [
      { kind: "prompt", text: "go" },
      { kind: "command", command: "ls" },
    ];

    await runStopHook(input(ran), deps);
    await appendRunEvent({ id: "r-1", cwd, name: "feat-x" }, denied("record-guard", "Write"));
    await runStopHook(input([...ran, { kind: "tool", name: "Write" }]), deps);

    const events = await jsonlEventStore(runDir).read();
    const reasons = events.flatMap((event) => {
      const stop = sdk.StopCalledEvent.safeParse(event);
      return stop.success ? [stop.data.payload.reason] : [];
    });
    expect(reasons).toEqual(["node-not-done", "unanswered-stop"]);
  });

  test("with interaction off, a refused question is not taken off the tool calls, so a command run beside it is still work", async () => {
    const { deps, runDir, cwd } = await setUp(planOpen, "claude", { policies: UNATTENDED });
    const ran: TranscriptEntry[] = [
      { kind: "prompt", text: "go" },
      { kind: "command", command: "ls" },
    ];

    await runStopHook(input(ran), deps);
    await appendRunEvent(
      { id: "r-1", cwd, name: "feat-x" },
      denied("question-guard", "AskUserQuestion"),
    );
    const asked: TranscriptEntry[] = [
      ...ran,
      { kind: "question" },
      { kind: "command", command: "pwd" },
    ];
    await runStopHook(input(asked), deps);

    const events = await jsonlEventStore(runDir).read();
    const reasons = events.flatMap((event) => {
      const stop = sdk.StopCalledEvent.safeParse(event);
      return stop.success ? [stop.data.payload.reason] : [];
    });
    expect(reasons).toEqual(["node-not-done", "node-not-done"]);
  });

  test("a block that cannot be logged lets the turn end, so an unsaved count can't trap the session", async () => {
    const { deps, runDir } = await setUp(planOpen);
    const log = join(runDir, "event.jsonl");
    await writeFile(log, "");
    await chmod(log, 0o444);

    expect(await runStopHook(input(undefined), deps)).toEqual({ kind: "allow" });
    expect(await readFile(log, "utf8")).toBe("");
  });

  test("a session the run does not own is never blocked and nothing is logged", async () => {
    const { deps, runDir } = await setUp(planOpen);
    const other = { ...input(undefined), sessionId: "other" };
    expect(await runStopHook(other, deps)).toEqual({ kind: "allow" });
    expect(await runStopHook(input(undefined), { ...deps, env: {} })).toEqual({ kind: "allow" });
    expect(await jsonlEventStore(runDir).read()).toEqual([]);
  });
});

describe("an open context node", () => {
  const contextOpen = { fresh: nodeRun("nr-1", "running", "context") };

  // The helper is a detached orchestrate process, so the spawn is the boundary these tests stop at.
  let spawn: ReturnType<typeof spyOn<typeof sdk, "spawnDetached">>;
  beforeAll(() => {
    spawn = spyOn(sdk, "spawnDetached");
  });
  beforeEach(() => spawn.mockImplementation(() => 0));
  afterEach(() => spawn.mockReset());
  afterAll(() => spawn.mockRestore());

  test("SC22: lets the turn end, records context-node and starts the helper for that node as the program's orchestrate context", async () => {
    const { deps, runDir, cwd } = await setUp(contextOpen);

    expect(await runStopHook(input(orchestrateAfterPrompt), deps)).toEqual({ kind: "allow" });

    const [program, ...self] = orchestrateArgv();
    expect(spawn.mock.calls).toEqual([
      [
        program,
        [...self, "context", "nr-1", "--run-id", "r-1", "--session-id", "s1"],
        { cwd, output: "ignore" },
      ],
    ]);
    expect((await jsonlEventStore(runDir).read()).map((e) => e.payload)).toEqual([
      expect.objectContaining({ decision: "allow", reason: "context-node", nodeRunId: "nr-1" }),
    ]);
  });

  test("SC15: a codex session's context node completes as not applied, the helper never starts, and the turn is sent to next", async () => {
    const { deps, runDir } = await setUp(contextOpen, "codex");
    await writeFile(
      join(runDir, "workflow.yaml"),
      "name: w\nnodes:\n  - id: fresh\n    type: context\n    action: new\n",
    );

    const reply = await runStopHook(input(orchestrateAfterPrompt, "codex"), deps);

    expect(reply).toMatchObject({ kind: "continue", message: expect.stringContaining("next") });
    expect(spawn).not.toHaveBeenCalled();
    const state = await readState(runDir);
    expect(state?.nodeRuns.fresh).toMatchObject({
      status: "completed",
      output: {
        applied: false,
        reason: "context steps are not supported on codex",
      },
    });
  });

  test("an open agent node still blocks and starts no helper", async () => {
    const { deps } = await setUp(planOpen);
    expect(await runStopHook(input(orchestrateAfterPrompt), deps)).toMatchObject({
      kind: "continue",
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  test("a stop whose event log holds an answered switch request and an unanswered one at seq 3 lets the turn end and starts the model helper for seq 3", async () => {
    const { deps, cwd } = await setUp({});
    const run = { id: "r-1", cwd, name: "feat-x" };
    const request = { node: "think", model: "opus-x" };
    const answer = { ...request, requestSeq: 1, applied: false, reason: "respawn failed" };
    await appendRunEvent(run, { type: "workflow.model.requested", source: "t", payload: request });
    await appendRunEvent(run, { type: "workflow.model.applied", source: "t", payload: answer });
    await appendRunEvent(run, { type: "workflow.model.requested", source: "t", payload: request });

    expect(await runStopHook(input(orchestrateAfterPrompt), deps)).toEqual({ kind: "allow" });

    const [program, ...self] = orchestrateArgv();
    expect(spawn.mock.calls).toEqual([
      [
        program,
        [...self, "model", "3", "--run-id", "r-1", "--session-id", "s1"],
        { cwd, output: "ignore" },
      ],
    ]);
  });

  test("a helper that cannot start still lets the stop through", async () => {
    const { deps } = await setUp(contextOpen);
    spawn.mockImplementation(() => {
      throw new Error("spawn failed");
    });

    expect(await runStopHook(input(orchestrateAfterPrompt), deps)).toEqual({ kind: "allow" });
  });
});
