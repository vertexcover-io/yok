import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  EmitInput,
  Event,
  JsonObject,
  JsonValue,
  NodeRun,
  ResolvedTiers,
  State,
  TierModel,
} from "@yok/sdk";
import { builtInHandlers, foldModelSwitch, projectEvents } from "@yok/sdk/internal";
import { compileWorkflow } from "./compile.ts";
import {
  type Decision,
  decideNext,
  type Leaf,
  type ModelInputs,
  type StartedLeaf,
} from "./next.ts";
import { DEMO_STAGES, writeStages } from "./test-stages.ts";
import type { WorkflowPlan } from "./types.ts";

type Stop = Decision;

// Compiles SOURCE as main.yml in a fresh folder that also holds any included workflow FILES and
// the demo stages under stages/.
const compilePlan = (
  source: string,
  files: Readonly<Record<string, string>> = {},
): Promise<WorkflowPlan> => {
  const root = mkdtempSync(join(tmpdir(), "wf-step-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  writeStages(join(root, "stages"), DEMO_STAGES);
  const path = join(root, "main.yml");
  writeFileSync(path, source);
  return compileWorkflow(path, { cwd: root });
};

const start = (input: JsonObject = {}): State => ({
  schemaVersion: 1,
  lastEventSeq: 0,
  runId: "r-1",
  runName: "demo",
  runDir: "/work/.yok/demo",
  version: "2.0.0",
  workflow: { name: "demo", path: "workflow.yaml" },
  input,
  scope: null,
  startedAt: "2026-09-28T09:00:00Z",
  completedAt: null,
  status: "running",
  workspace: {
    type: "mono",
    path: "/work",
    repositories: {
      app: { path: "/work", git: { branch: "b", baseBranch: "main", startSha: "a" } },
    },
  },
  nodeRuns: {},
  activeSessions: [],
  tiers: null,
  eventHandlers: {},
  subscribers: {},
});

// The event emitRunEvent would store for DRAFT: the next seq after the state's.
const toEvent = (state: State, draft: EmitInput): Event => {
  const seq = state.lastEventSeq + 1;
  return {
    ...draft,
    schemaVersion: 1,
    seq,
    id: `e${seq}`,
    ts: new Date(Date.UTC(2026, 8, 28, 9, 0, seq)).toISOString(),
    runId: "r-1",
  };
};

// Stores one event the way emitRunEvent would: next seq, then the core reducers.
const apply = (state: State, draft: EmitInput): State =>
  projectEvents({ state, events: [toEvent(state, draft)], handlers: builtInHandlers });

type Advanced = Readonly<{ state: State; stop: Stop; events: readonly EmitInput[] }>;

// What one `orchestrate next` does, with events stored in memory instead of event.jsonl.
const advance = async (
  plan: WorkflowPlan,
  state: State,
  models: Partial<ModelInputs> = {},
): Promise<Advanced> => {
  const events: EmitInput[] = [];
  const emit = async (current: State, event: EmitInput): Promise<State> => {
    events.push(event);
    return apply(current, event);
  };
  const { state: after, decision } = await decideNext(plan, state, emit, {
    tiers: null,
    switching: { current: null, pending: null, failed: null },
    subagents: false,
    parallel: true,
    ...models,
  });
  return { state: after, stop: decision, events };
};

// Where a node run sits in state.json's tree: its node id and the ids of the containers above it.
const locateRun = (
  nodes: Readonly<Record<string, NodeRun>>,
  nodeRunId: string,
  parents: readonly string[] = [],
): Readonly<{ nodeId: string; parents: readonly string[] }> | undefined => {
  for (const [nodeId, run] of Object.entries(nodes)) {
    if (run.nodeRunId === nodeRunId) return { nodeId, parents };
    const inside = locateRun(run.nodes ?? {}, nodeRunId, [...parents, nodeId]);
    if (inside !== undefined) return inside;
  }
  return undefined;
};

// What `orchestrate exec` records when a leaf ends, or `orchestrate resume` when it interrupts one.
const end = (
  state: State,
  nodeRunId: string,
  status: "completed" | "failed" | "interrupted",
  extra: Readonly<Record<string, JsonValue>> = {},
): State => {
  const where = locateRun(state.nodeRuns, nodeRunId);
  if (where === undefined) throw new Error(`no node run ${nodeRunId}`);
  const parents = where.parents.length === 0 ? {} : { parents: [...where.parents] };
  const payload = { nodeType: "exec", attempts: 1, ...parents, ...extra };
  return apply(state, {
    type: `workflow.node.${status}`,
    source: "test",
    nodeId: where.nodeId,
    nodeRunId,
    payload,
  });
};

const expectSteps = (stop: Stop): readonly StartedLeaf[] => {
  if (stop.kind !== "steps") throw new Error(`expected steps, got ${stop.kind}`);
  return stop.steps;
};

// The one leaf a `steps` reply hands out.
const expectLeaf = (stop: Stop): StartedLeaf => {
  const [leaf, ...rest] = expectSteps(stop);
  if (leaf === undefined || rest.length > 0) throw new Error("expected exactly one step");
  return leaf;
};

const expectContext = (stop: Stop): Extract<Decision, { kind: "context" }> => {
  if (stop.kind !== "context") throw new Error(`expected a context step, got ${stop.kind}`);
  return stop;
};

const stepIds = (stop: Stop): readonly string[] => expectSteps(stop).map(({ node }) => node.id);

const waitingOn = (stop: Stop): readonly string[] => {
  if (stop.kind !== "waiting") throw new Error(`expected waiting, got ${stop.kind}`);
  return stop.running.map(({ nodeId }) => nodeId);
};

// The node's entry in state.json, found by the ids from the top of the workflow down to it.
const findRun = (state: State, ...ids: readonly string[]): NodeRun | undefined =>
  ids.reduce<NodeRun | undefined>(
    (run, id, depth) => (depth === 0 ? state.nodeRuns[id] : run?.nodes?.[id]),
    undefined,
  );

const exec = (id: string, extra = ""): string => `
  - id: ${id}
    type: exec
    runtime: sh
    script: "true"${extra}`;

describe("decideNext", () => {
  test("IW1 — a is handed out alone, and b is handed out after it with a's output as its input", async () => {
    const plan = await compilePlan(`name: t
nodes:${exec("a", "\n    input: {}")}${exec("b", '\n    dependsOn: [a]\n    input: "{{ nodes.a.output.n }}"')}
`);
    const first = await advance(plan, start());
    const a = expectLeaf(first.stop);
    expect(a.node.id).toBe("a");
    expect(a.nodeRunId).toMatch(/^nr-[0-9a-f]{16}$/);
    expect(waitingOn((await advance(plan, first.state)).stop)).toEqual([a.node.id]);

    const afterA = end(first.state, a.nodeRunId, "completed", { output: { n: 7 } });
    const second = await advance(plan, afterA);
    const b = expectLeaf(second.stop);
    expect(b.node.id).toBe("b");
    expect(b.nodeRunId).toMatch(/^nr-[0-9a-f]{16}$/);
    expect(findRun(second.state, "b")).toMatchObject({
      nodeRunId: b.nodeRunId,
      input: 7,
      status: "running",
    });
  });

  test("IW2 — a node whose when is false is skipped without starting, and so is the node depending on it", async () => {
    const plan = await compilePlan(`name: t
inputs:
  flag: { type: boolean, required: true }
nodes:${exec("a", '\n    when: "{{ inputs.flag }}"\n    input: {}')}${exec("b", "\n    dependsOn: [a]\n    input: {}")}
`);
    const done = await advance(plan, start({ flag: false }));
    expect(done.stop).toEqual({ kind: "finished", status: "completed" });
    expect(findRun(done.state, "a")).toMatchObject({
      status: "skipped",
      output: { reason: "when-false", proof: { expression: "{{ inputs.flag }}", value: false } },
    });
    expect(findRun(done.state, "b")).toMatchObject({
      status: "skipped",
      output: { reason: "dependency-skipped", proof: { dependencies: ["a"] } },
    });
    expect(done.events.map((event) => event.payload)).toContainEqual(
      expect.objectContaining({ skip: expect.objectContaining({ reason: "when-false" }) }),
    );
  });

  test("IW42 — a dependency-skipped node names only the dependencies that were skipped", async () => {
    const plan = await compilePlan(`name: t
nodes:${exec("a", '\n    when: "{{ false }}"\n    input: {}')}${exec("b", "\n    input: {}")}${exec("c", "\n    dependsOn: [a, b]\n    input: {}")}
`);
    const first = await advance(plan, start());
    const b = expectLeaf(first.stop);
    const done = await advance(plan, end(first.state, b.nodeRunId, "completed", { output: {} }));
    expect(done.events[0]).toMatchObject({
      type: "workflow.node.skipped",
      nodeId: "c",
      payload: { skip: { reason: "dependency-skipped", proof: { dependencies: ["a"] } } },
    });
  });

  test("IW3 — after a fails, neither its dependent b nor the independent c starts, and the run ends failed", async () => {
    const plan = await compilePlan(`name: t
nodes:${exec("a", "\n    input: {}")}${exec("b", "\n    dependsOn: [a]\n    input: {}")}${exec("c", "\n    input: {}")}
`);
    const first = await advance(plan, start());
    const error = { kind: "exit", message: "exited with code 3" };
    const failed = end(first.state, expectLeaf(first.stop).nodeRunId, "failed", { error });
    expect((await advance(plan, failed)).events[0]).toMatchObject({ type: "workflow.failed" });
    const done = await advance(plan, failed);
    expect(done.stop).toEqual({ kind: "finished", status: "failed" });
    expect(findRun(done.state, "b")).toBeUndefined();
    expect(findRun(done.state, "c")).toBeUndefined();
  });

  test("SC1: after a fails, b never starts but c with always: true is handed out, and the run still ends failed", async () => {
    const plan = await compilePlan(`name: t
nodes:${exec("a", "\n    input: {}")}${exec("b", "\n    dependsOn: [a]\n    input: {}")}${exec("c", "\n    always: true\n    dependsOn: [b]\n    input: {}")}
`);
    const { state } = await runLeaves(plan, start(), ["failed"]);
    const second = await advance(plan, state);
    expect(expectLeaf(second.stop).node.id).toBe("c");
    expect(findRun(second.state, "b")).toBeUndefined();
    const ended = end(second.state, expectLeaf(second.stop).nodeRunId, "completed", { output: {} });
    const done = await advance(plan, ended);
    expect(done.stop).toEqual({ kind: "finished", status: "failed" });
    expect(findRun(done.state, "c")?.status).toBe("completed");
    expect(findRun(done.state, "b")).toBeUndefined();
  });

  test("SC2: a failed always: true node with allowFailure leaves a passing run completed", async () => {
    const plan = await compilePlan(`name: t
nodes:${exec("a", "\n    input: {}")}${exec("c", "\n    always: true\n    allowFailure: true\n    dependsOn: [a]\n    input: {}")}
`);
    const { state } = await runLeaves(plan, start(), ["completed", "failed"]);
    const done = await advance(plan, state);
    expect(done.stop).toEqual({ kind: "finished", status: "completed" });
    expect(findRun(done.state, "c")?.status).toBe("failed");
  });

  test("SC3: an always: true node is handed out when its dependency was skipped, not recorded dependency-skipped", async () => {
    const plan = await compilePlan(`name: t
nodes:${exec("a", '\n    when: "{{ false }}"\n    input: {}')}${exec("c", "\n    always: true\n    dependsOn: [a]\n    input: {}")}
`);
    const first = await advance(plan, start());
    expect(findRun(first.state, "a")?.status).toBe("skipped");
    expect(expectLeaf(first.stop).node.id).toBe("c");
    expect(findRun(first.state, "c")?.status).toBe("running");
  });

  test("SC4: after a fails, an always: true node whose when is false is still skipped as when-false, and the run ends failed", async () => {
    const plan = await compilePlan(`name: t
nodes:${exec("a", "\n    input: {}")}${exec("c", '\n    always: true\n    when: "{{ false }}"\n    input: {}')}
`);
    const { state } = await runLeaves(plan, start(), ["failed"]);
    const done = await advance(plan, state);
    expect(done.stop).toEqual({ kind: "finished", status: "failed" });
    expect(findRun(done.state, "c")).toMatchObject({
      status: "skipped",
      output: { reason: "when-false" },
    });
  });

  test("a failed node with allowFailure lets its dependent and the nodes after it run, and the run ends completed", async () => {
    const plan = await compilePlan(`name: t
nodes:${exec("a", "\n    allowFailure: true\n    input: {}")}${exec("b", '\n    dependsOn: [a]\n    input: "{{ nodes.a.status }}"')}${exec("c", "\n    input: {}")}
`);
    const { state, inputs } = await runLeaves(plan, start(), ["failed", "completed", "completed"]);
    expect(inputs).toEqual([{}, "failed", {}]);
    const done = await advance(plan, state);
    expect(done.stop).toEqual({ kind: "finished", status: "completed" });
    expect(findRun(done.state, "a")?.status).toBe("failed");
  });

  test("an allowed failure does not hide an ordinary failure after it: the run still ends failed", async () => {
    const plan = await compilePlan(`name: t
nodes:${exec("a", "\n    allowFailure: true\n    input: {}")}${exec("b", "\n    input: {}")}${exec("c", "\n    input: {}")}
`);
    const { state } = await runLeaves(plan, start(), ["failed", "failed"]);
    const done = await advance(plan, state);
    expect(done.stop).toEqual({ kind: "finished", status: "failed" });
    expect(findRun(done.state, "c")).toBeUndefined();
  });

  test("SC512: after allowFailure a fails with needs-input, b never starts, always c is handed out, and the run ends failed", async () => {
    const plan = await compilePlan(`name: t
nodes:${exec("a", "\n    allowFailure: true\n    input: {}")}${exec("b", "\n    dependsOn: [a]\n    input: {}")}${exec("c", "\n    always: true\n    dependsOn: [b]\n    input: {}")}
`);
    const first = await advance(plan, start());
    const failed = end(first.state, expectLeaf(first.stop).nodeRunId, "failed", {
      error: { kind: "needs-input", message: "Which region?" },
    });
    const second = await advance(plan, failed);
    expect(expectLeaf(second.stop).node.id).toBe("c");
    const ended = end(second.state, expectLeaf(second.stop).nodeRunId, "completed", { output: {} });
    const done = await advance(plan, ended);
    expect(done.stop).toEqual({ kind: "finished", status: "failed" });
    expect(findRun(done.state, "b")).toBeUndefined();
  });

  test("SC513: after allowFailure a fails with exception, b is handed out and the run ends completed", async () => {
    const plan = await compilePlan(`name: t
nodes:${exec("a", "\n    allowFailure: true\n    input: {}")}${exec("b", "\n    dependsOn: [a]\n    input: {}")}${exec("c", "\n    always: true\n    dependsOn: [b]\n    input: {}")}
`);
    const first = await advance(plan, start());
    const failed = end(first.state, expectLeaf(first.stop).nodeRunId, "failed", {
      error: { kind: "exception", message: "boom" },
    });
    expect(expectLeaf((await advance(plan, failed)).stop).node.id).toBe("b");
    const { state } = await runLeaves(plan, failed, ["completed", "completed"]);
    const done = await advance(plan, state);
    expect(done.stop).toEqual({ kind: "finished", status: "completed" });
  });

  test("SC514: an always, allowFailure retro that fails with needs-input after a completed leaves the run completed", async () => {
    const plan = await compilePlan(`name: t
nodes:${exec("a", "\n    input: {}")}${exec("retro", "\n    always: true\n    allowFailure: true\n    dependsOn: [a]\n    input: {}")}
`);
    const { state } = await runLeaves(plan, start(), ["completed"]);
    const second = await advance(plan, state);
    const failed = end(second.state, expectLeaf(second.stop).nodeRunId, "failed", {
      error: { kind: "needs-input", message: "Which region?" },
    });
    const done = await advance(plan, failed);
    expect(done.stop).toEqual({ kind: "finished", status: "completed" });
    expect(findRun(done.state, "retro")?.status).toBe("failed");
  });

  test("IW4 — while background a runs, nothing else starts, not even independent c; then b and c follow one at a time", async () => {
    const plan = await compilePlan(`name: t
nodes:${exec("a", "\n    mode: background\n    input: {}")}${exec("b", "\n    dependsOn: [a]\n    input: {}")}${exec("c", "\n    input: {}")}
`);
    const first = await advance(plan, start());
    const a = expectLeaf(first.stop);
    expect(a.node).toMatchObject({ id: "a", mode: "background" });
    expect(waitingOn((await advance(plan, first.state)).stop)).toEqual([a.node.id]);

    const afterA = end(first.state, a.nodeRunId, "completed", { output: {} });
    const second = await advance(plan, afterA);
    const b = expectLeaf(second.stop);
    expect(b.node.id).toBe("b");
    expect(waitingOn((await advance(plan, second.state)).stop)).toEqual([b.node.id]);
    const afterB = end(second.state, b.nodeRunId, "completed", { output: {} });
    expect(expectLeaf((await advance(plan, afterB)).stop).node.id).toBe("c");
  });

  test("SC309: an interrupted b is handed out again under a new node run id, and a's finished run is untouched", async () => {
    const plan = await compilePlan(`name: t
nodes:${exec("a", "\n    input: {}")}${exec("b", "\n    dependsOn: [a]\n    input: {}")}
`);
    const first = await advance(plan, start());
    const a = expectLeaf(first.stop);
    const afterA = end(first.state, a.nodeRunId, "completed", { output: {} });
    const second = await advance(plan, afterA);
    const b = expectLeaf(second.stop);
    const interrupted = end(second.state, b.nodeRunId, "interrupted");

    const again = await advance(plan, interrupted);
    const retried = expectLeaf(again.stop);
    expect(retried.node.id).toBe("b");
    expect(retried.nodeRunId).not.toBe(b.nodeRunId);
    expect(findRun(again.state, "b")).toMatchObject({
      nodeRunId: retried.nodeRunId,
      status: "running",
    });
    expect(findRun(again.state, "a")).toEqual(findRun(afterA, "a"));
  });

  test("IW5 — once every node has ended the run is recorded completed, and every later call replies finished", async () => {
    const plan = await compilePlan(`name: t
nodes:${exec("a", "\n    input: {}")}
`);
    const first = await advance(plan, start());
    const ended = end(first.state, expectLeaf(first.stop).nodeRunId, "completed", { output: {} });
    expect((await advance(plan, ended)).events[0]).toMatchObject({ type: "workflow.completed" });
    const done = await advance(plan, ended);
    expect(done.state).toMatchObject({ status: "completed", completedAt: expect.any(String) });
    expect((await advance(plan, done.state)).stop).toEqual({
      kind: "finished",
      status: "completed",
    });
  });

  test("IW6 — an input that reads a missing field fails that node at start with a resolution error", async () => {
    const plan = await compilePlan(`name: t
nodes:${exec("a", "\n    input: {}")}${exec("b", '\n    dependsOn: [a]\n    input: "{{ nodes.a.output.missing }}"')}
`);
    const first = await advance(plan, start());
    const afterA = end(first.state, expectLeaf(first.stop).nodeRunId, "completed", { output: {} });
    expect((await advance(plan, afterA)).events[0]).toMatchObject({
      type: "workflow.node.failed",
      nodeId: "b",
      payload: { error: { kind: "resolution" } },
    });
    const done = await advance(plan, afterA);
    expect(findRun(done.state, "b")).toMatchObject({ status: "failed", startedAt: null });
    expect(done.stop).toEqual({ kind: "finished", status: "failed" });
  });
});

const stage = (id: string, name: string, extra = ""): string => `
  - id: ${id}
    type: agent
    stage: stages/${name}${extra}`;

const PLAN_ARTIFACT = { artifacts: [{ type: "plan", name: "plan", path: "artifacts/plan.md" }] };

describe("decideNext with stage and agent nodes", () => {
  test("IW13 — a stage node is handed out with its resolved input, and its reported output feeds the next node", async () => {
    const plan = await compilePlan(`name: t
inputs:
  prompt: { type: string, required: true }
nodes:${stage("make", "producer", '\n    input: { request: "{{ inputs.prompt }}" }')}${exec("b", '\n    dependsOn: [make]\n    input: "{{ nodes.make.output.ok }}"')}
`);
    const first = await advance(plan, start({ prompt: "hi" }));
    const make = expectLeaf(first.stop);
    expect(make).toMatchObject({
      node: { id: "make", stage: { ref: "stages/producer" } },
      input: { request: "hi" },
      variables: {},
    });
    const afterMake = end(first.state, make.nodeRunId, "completed", { output: { ok: true } });
    const b = expectLeaf((await advance(plan, afterMake)).stop);
    expect(b).toMatchObject({ node: { id: "b" }, input: true });
  });

  test("a stage node is handed out with its skill's variable defaults under the node's own values, an expression read like its input", async () => {
    const plan = await compilePlan(`name: t
inputs:
  who: { type: string, required: true }
nodes:${stage("say", "tuned", '\n    input: {}\n    variables: { audience: "{{ inputs.who }}" }')}
`);
    const say = expectLeaf((await advance(plan, start({ who: "devs" }))).stop);
    expect(say.variables).toEqual({ tone: "plain", audience: "devs" });
    const overridden = await compilePlan(`name: t
nodes:${stage("shout", "tuned", "\n    input: {}\n    variables: { tone: loud, audience: all }")}
`);
    const shout = expectLeaf((await advance(overridden, start())).stop);
    expect(shout.variables).toEqual({ tone: "loud", audience: "all" });
  });

  test.each([
    ["reads a missing input", "{{ inputs.nobody }}", "nobody"],
    ["is not a string", "{{ inputs.count }}", "string"],
  ])("a stage node whose variable %s fails before it starts", async (_label, value, message) => {
    const plan = await compilePlan(`name: t
inputs:
  count: { type: number, default: 3 }
nodes:${stage("say", "tuned", `\n    input: {}\n    variables: { audience: "${value}" }`)}
`);
    const done = await advance(plan, start());
    expect(done.stop).toEqual({ kind: "finished", status: "failed" });
    expect(findRun(done.state, "say")).toMatchObject({
      status: "failed",
      startedAt: null,
      output: { kind: "resolution", message: expect.stringContaining(message) },
    });
  });

  // Only agent.resumed, from the Bash call that ran next, puts the run back to running.
  test("SC133: next on a run blocked on an agent error after design completed hands out planning, and its start leaves the agent-error blocker in place", async () => {
    const plan = await compilePlan(`name: t
nodes:${stage("design", "plain", "\n    input: {}")}${stage("planning", "plain", "\n    dependsOn: [design]\n    input: {}")}
`);
    const first = await advance(plan, start());
    const designed = end(first.state, expectLeaf(first.stop).nodeRunId, "completed", {
      output: {},
    });
    const blocked = apply(designed, {
      type: "agent.stopped",
      source: "hooks",
      payload: { agent: "claude", sessionId: "s1", error: "authentication_failed" },
    });
    expect(blocked.status).toBe("blocked");

    const { stop, state } = await advance(plan, blocked);
    expect(expectLeaf(stop).node.id).toBe("planning");
    expect(state.status).toBe("blocked");
    expect(state.blocker).toEqual(blocked.blocker);
  });

  test("IW14 — a stage whose producer completed without its artifact is blocked, and is handed out once the producer lists it", async () => {
    const plan = await compilePlan(`name: t
nodes:${stage("use", "consumer", "\n    dependsOn: [make]\n    input: {}")}${stage("make", "producer", "\n    input: {}")}
`);
    const first = await advance(plan, start());
    const make = expectLeaf(first.stop);
    expect(make.node.id).toBe("make");
    expect(findRun(first.state, "use")).toBeUndefined();
    expect(waitingOn((await advance(plan, first.state)).stop)).toEqual([make.node.id]);

    const withoutPlan = end(first.state, make.nodeRunId, "completed", { output: {} });
    expect((await advance(plan, withoutPlan)).stop).toEqual({
      kind: "blocked",
      nodeId: "use",
      stage: "stages/consumer",
      missing: ["plan"],
    });
    const withPlan = end(first.state, make.nodeRunId, "completed", {
      output: {},
      ...PLAN_ARTIFACT,
    });
    expect(expectLeaf((await advance(plan, withPlan)).stop).node.id).toBe("use");
  });

  test("a stage consumes an artifact by its type, whatever the artifact is named", async () => {
    const plan = await compilePlan(`name: t
nodes:${stage("use", "consumer", "\n    dependsOn: [make]\n    input: {}")}${stage("make", "producer", "\n    input: {}")}
`);
    const first = await advance(plan, start());
    const make = expectLeaf(first.stop);
    const named = end(first.state, make.nodeRunId, "completed", {
      output: {},
      artifacts: [{ type: "plan", name: "checkout-plan", path: "artifacts/plan.md" }],
    });
    expect(expectLeaf((await advance(plan, named)).stop).node.id).toBe("use");
  });

  test("a blocked stage records workflow.blocked with its node, stage and missing artifacts, under an id fixed per node", async () => {
    const plan = await compilePlan(`name: t
nodes:${stage("use", "consumer", "\n    dependsOn: [make]\n    input: {}")}${stage("make", "producer", "\n    input: {}")}
`);
    const first = await advance(plan, start());
    const make = expectLeaf(first.stop);

    const blocked = await advance(
      plan,
      end(first.state, make.nodeRunId, "completed", { output: {} }),
    );

    expect(blocked.events).toEqual([
      {
        id: "workflow-blocked:use",
        type: "workflow.blocked",
        source: "workflow",
        nodeId: "use",
        payload: { nodeId: "use", stage: "stages/consumer", missing: ["plan"] },
      },
    ]);
  });

  test("x, started by the same next that finds use blocked, is handed out, and the next next reports the block", async () => {
    const plan = await compilePlan(`name: t
nodes:${stage("make", "producer", "\n    input: {}")}${exec("x", "\n    dependsOn: [make]\n    input: {}")}${stage("use", "consumer", "\n    dependsOn: [make]\n    input: {}")}
`);
    const first = await advance(plan, start());
    const make = expectLeaf(first.stop);
    const withoutPlan = end(first.state, make.nodeRunId, "completed", { output: {} });
    const second = await advance(plan, withoutPlan);
    expect(stepIds(second.stop)).toEqual(["x"]);
    expect((await advance(plan, second.state)).stop).toEqual({
      kind: "blocked",
      nodeId: "use",
      stage: "stages/consumer",
      missing: ["plan"],
    });
  });

  test("IW15 — an optional consumed artifact never blocks its stage", async () => {
    const plan = await compilePlan(`name: t
nodes:${stage("read", "reader", "\n    input: {}")}
`);
    expect(expectLeaf((await advance(plan, start())).stop).node.id).toBe("read");
  });

  test("IW16 — an agent node with a prompt and no stage is handed out with its input", async () => {
    const plan = await compilePlan(`name: t
nodes:
  - id: ask
    type: agent
    prompt: summarise
    input: { text: x }
`);
    const ask = expectLeaf((await advance(plan, start())).stop);
    expect(ask).toMatchObject({ node: { id: "ask", prompt: "summarise" }, input: { text: "x" } });
  });
});

// A run's state with every event stored so far, which the model switch is folded from.
type Logged = Readonly<{ state: State; log: readonly Event[] }>;

const record = (run: Logged, draft: EmitInput): Logged => {
  const event = toEvent(run.state, draft);
  const state = projectEvents({ state: run.state, events: [event], handlers: builtInHandlers });
  return { state, log: [...run.log, event] };
};

type TieredAdvance = Readonly<{ run: Logged; stop: Stop; events: readonly EmitInput[] }>;

// One `orchestrate next` on a run with TIERS whose session was launched on LAUNCH.
const advanceTiered = async (
  plan: WorkflowPlan,
  run: Logged,
  tiers: ResolvedTiers | null,
  launch: TierModel | null = null,
  subagents = false,
): Promise<TieredAdvance> => {
  const events: EmitInput[] = [];
  let current = run;
  const emit = async (_state: State, draft: EmitInput): Promise<State> => {
    events.push(draft);
    current = record(current, draft);
    return current.state;
  };
  const launched = launch === null ? null : { default: "launch", models: { launch } };
  const switching = foldModelSwitch(run.log, launched);
  const models = { tiers, switching, subagents, parallel: true };
  const { decision } = await decideNext(plan, run.state, emit, models);
  return { run: current, stop: decision, events };
};

const fresh = (): Logged => ({ state: start(), log: [] });
const lastSeq = (run: Logged): number => run.log.at(-1)?.seq ?? 0;
const answer = (run: Logged, result: Readonly<Record<string, JsonValue>>): Logged =>
  record(run, {
    type: "workflow.model.applied",
    source: "orchestrate",
    payload: { requestSeq: lastSeq(run), node: "think", model: "opus-x", ...result },
  });

const OPUS_HIGH: TierModel = { model: "opus-x", effort: "high" };
const HAIKU: TierModel = { model: "haiku-x" };
const DEEP: ResolvedTiers = { default: "deep", models: { deep: OPUS_HIGH } };
const FAST_AND_DEEP: ResolvedTiers = { default: "deep", models: { fast: HAIKU, deep: OPUS_HIGH } };
const SWITCH_FAILED = {
  applied: false,
  reason: "no SessionStart within 60 seconds after resuming on opus-x",
};
const THINKER_FLOW = `name: t
nodes:${stage("think", "thinker", "\n    input: {}")}
`;

describe("decideNext with stage tiers", () => {
  test("SC1: a tier: deep stage on a session not on opus-x gets a model step, stores one model request, and does not start", async () => {
    const plan = await compilePlan(THINKER_FLOW);
    const { stop, events, run } = await advanceTiered(plan, fresh(), DEEP);
    expect(stop).toEqual({ kind: "model", nodeId: "think", model: "opus-x", effort: "high" });
    expect(events).toEqual([
      expect.objectContaining({
        type: "workflow.model.requested",
        payload: { node: "think", model: "opus-x", effort: "high" },
      }),
    ]);
    expect(run.state.nodeRuns.think).toBeUndefined();
  });

  test("SC2: once the switch to opus-x/high is applied, the next call hands out the stage", async () => {
    const plan = await compilePlan(THINKER_FLOW);
    const first = await advanceTiered(plan, fresh(), DEEP);
    const switched = answer(first.run, { applied: true, effort: "high" });
    const second = await advanceTiered(plan, switched, DEEP);
    expect(expectLeaf(second.stop).node.id).toBe("think");
    expect(second.events.filter((event) => event.type.startsWith("workflow.model."))).toEqual([]);
  });

  test("a tier: fast stage on a run whose models lack fast fails, naming the tier and the tiers there are", async () => {
    const plan = await compilePlan(`name: t
nodes:${stage("make", "quick", "\n    input: {}")}
`);
    const { stop, run } = await advanceTiered(plan, fresh(), DEEP);
    expect(run.state.nodeRuns.make).toMatchObject({
      status: "failed",
      output: {
        message: expect.stringContaining('tier "fast" is not one of the run\'s tiers: deep'),
      },
    });
    expect(stop).toEqual({ kind: "finished", status: "failed" });
  });

  test("a run whose agent cannot switch models hands out a deep stage with no model event", async () => {
    const plan = await compilePlan(THINKER_FLOW);
    const { stop, events } = await advanceTiered(plan, fresh(), null);
    expect(expectLeaf(stop).node.id).toBe("think");
    expect(events.filter((event) => event.type.startsWith("workflow.model."))).toEqual([]);
  });

  const SWITCHES: readonly (readonly [string, TierModel | null, TierModel, "model" | "steps"])[] = [
    [
      "sonnet-x/high to opus-x/high switches",
      { model: "sonnet-x", effort: "high" },
      OPUS_HIGH,
      "model",
    ],
    ["opus-x/low to opus-x/high switches", { model: "opus-x", effort: "low" }, OPUS_HIGH, "model"],
    [
      "SC4: opus-x/high to opus-x with no effort starts the stage",
      OPUS_HIGH,
      { model: "opus-x" },
      "steps",
    ],
    ["opus-x/high to opus-x/high starts the stage", OPUS_HIGH, OPUS_HIGH, "steps"],
  ];
  test.each(SWITCHES)("a deep stage, session on %s", async (_label, launch, target, kind) => {
    const plan = await compilePlan(THINKER_FLOW);
    const tiers = { default: "deep", models: { deep: target } };
    const { stop } = await advanceTiered(plan, fresh(), tiers, launch);
    expect(stop.kind).toBe(kind);
  });

  test("SC6: a second next while the switch for the stage is pending returns the same model step and stores nothing", async () => {
    const plan = await compilePlan(THINKER_FLOW);
    const first = await advanceTiered(plan, fresh(), DEEP);
    const again = await advanceTiered(plan, first.run, DEEP);
    expect(again.stop).toEqual(first.stop);
    expect(again.events).toEqual([]);
  });

  test("SC5: a failed switch fails the stage with its reason, and the run ends failed", async () => {
    const plan = await compilePlan(THINKER_FLOW);
    const first = await advanceTiered(plan, fresh(), DEEP);
    const { stop, run } = await advanceTiered(plan, answer(first.run, SWITCH_FAILED), DEEP);
    expect(run.state.nodeRuns.think).toMatchObject({
      status: "failed",
      output: {
        message: expect.stringContaining(
          "no SessionStart within 60 seconds after resuming on opus-x",
        ),
      },
    });
    expect(stop).toEqual({ kind: "finished", status: "failed" });
  });

  test("in a loop, a stage that allows failure and whose switch failed on pass 1 asks for the switch again on pass 2", async () => {
    const plan = await compilePlan(`name: t
nodes:
  - id: fix
    type: loop
    until: "{{ iteration.index >= 2 }}"
    maxIterations: 3
    input: {}
    nodes:
      - { id: think, type: agent, stage: stages/thinker, allowFailure: true, input: {} }
`);
    const first = await advanceTiered(plan, fresh(), DEEP);
    const failed = record(first.run, {
      type: "workflow.model.applied",
      source: "orchestrate",
      payload: {
        requestSeq: lastSeq(first.run),
        node: "fix.think",
        model: "opus-x",
        ...SWITCH_FAILED,
      },
    });
    const second = await advanceTiered(plan, failed, DEEP);
    expect(second.stop).toEqual({
      kind: "model",
      nodeId: "think",
      model: "opus-x",
      effort: "high",
    });
    expect(second.events.map((event) => event.type)).toContain("workflow.model.requested");
  });

  test("SC7: exec and context nodes are handed out with no model step, though the session is on no model", async () => {
    const plan = await compilePlan(`name: t
nodes:${exec("a", "\n    input: {}")}
  - { id: fresh, type: context, action: new, dependsOn: [a] }
`);
    const walk = async (state: State, handed: readonly string[]): Promise<readonly string[]> => {
      const { stop, events, run } = await advanceTiered(plan, { state, log: [] }, FAST_AND_DEEP);
      expect(events.filter((event) => event.type.startsWith("workflow.model."))).toEqual([]);
      if (stop.kind === "finished") return handed;
      const leaf = stop.kind === "context" ? stop : expectLeaf(stop);
      return walk(end(run.state, leaf.nodeRunId, "completed", { output: {} }), [
        ...handed,
        leaf.node.id,
      ]);
    };
    expect(await walk(start(), [])).toEqual(["a", "fresh"]);
  });

  test.each<[string, string, TierModel | null, Decision]>([
    [
      "a node tier: deep on a tier: fast stage beats the stage's, so a session on haiku-x",
      stage("make", "quick", "\n    tier: deep\n    input: {}"),
      HAIKU,
      { kind: "model", nodeId: "make", model: "opus-x", effort: "high" },
    ],
    [
      "a prompt agent node with tier: fast on a session on opus-x",
      "\n  - { id: ask, type: agent, prompt: summarise, input: {}, tier: fast }",
      OPUS_HIGH,
      { kind: "model", nodeId: "ask", model: "haiku-x" },
    ],
    [
      "a prompt agent node with no tier, on a session on no model, takes the default deep tier, so it",
      "\n  - { id: ask, type: agent, prompt: summarise, input: {} }",
      null,
      { kind: "model", nodeId: "ask", model: "opus-x", effort: "high" },
    ],
  ])("%s gets a model step for the tier's model", async (_label, nodes, launch, expected) => {
    const plan = await compilePlan(`name: t\nnodes:${nodes}\n`);
    const { stop } = await advanceTiered(plan, fresh(), FAST_AND_DEEP, launch);
    expect(stop).toEqual(expected);
  });

  test("a stage with no tier after a fast stage switches the session back from haiku-x to the default deep tier's opus-x", async () => {
    const plan = await compilePlan(`name: t
nodes:${stage("make", "quick", "\n    input: {}")}${stage("tidy", "plain", "\n    input: {}\n    dependsOn: [make]")}
`);
    const toFast = await advanceTiered(plan, fresh(), FAST_AND_DEEP, OPUS_HIGH);
    expect(toFast.stop).toMatchObject({ kind: "model", nodeId: "make", model: "haiku-x" });
    const onFast = record(toFast.run, {
      type: "workflow.model.applied",
      source: "orchestrate",
      payload: { requestSeq: lastSeq(toFast.run), node: "make", model: "haiku-x", applied: true },
    });
    const make = await advanceTiered(plan, onFast, FAST_AND_DEEP, OPUS_HIGH);
    const ended = end(make.run.state, expectLeaf(make.stop).nodeRunId, "completed", {
      output: {},
    });
    const { stop } = await advanceTiered(
      plan,
      { state: ended, log: make.run.log },
      FAST_AND_DEEP,
      OPUS_HIGH,
    );
    expect(stop).toEqual({ kind: "model", nodeId: "tidy", model: "opus-x", effort: "high" });
  });

  const CLAUDE_TIERS: ResolvedTiers = {
    default: "fast",
    models: { fast: { model: "claude-sonnet-5-5" }, deep: { model: "claude-opus-5-5" } },
  };
  const DESIGN_THEN_LINT = `name: t
nodes:${stage("design", "thinker", "\n    input: {}")}${exec("lint", "\n    dependsOn: [design]\n    input: {}")}
`;
  const withSession = (state: State): Logged => ({
    state: { ...state, activeSessions: [{ agent: "claude", sessionId: "s1" }] },
    log: [],
  });

  test("SC131: a deep stage started after the switch to claude-opus-5-5 records agent claude, tier deep, that model and session s1; the exec after it records neither field", async () => {
    const plan = await compilePlan(DESIGN_THEN_LINT);
    const requested = await advanceTiered(plan, withSession(start()), CLAUDE_TIERS);
    const switched = record(requested.run, {
      type: "workflow.model.applied",
      source: "orchestrate",
      payload: {
        requestSeq: lastSeq(requested.run),
        node: "design",
        model: "claude-opus-5-5",
        applied: true,
      },
    });
    const design = await advanceTiered(plan, switched, CLAUDE_TIERS);

    expect(design.run.state.nodeRuns.design).toMatchObject({
      stage: "thinker",
      agentState: {
        agent: "claude",
        tier: "deep",
        model: "claude-opus-5-5",
        sessionId: "s1",
        tokens: null,
      },
    });
    const ended = end(design.run.state, expectLeaf(design.stop).nodeRunId, "completed", {
      output: {},
    });
    const lint = await advanceTiered(plan, { ...design.run, state: ended }, CLAUDE_TIERS);
    expect(expectLeaf(lint.stop).node.id).toBe("lint");
    expect(lint.run.state.nodeRuns.lint).not.toHaveProperty("stage");
    expect(lint.run.state.nodeRuns.lint).not.toHaveProperty("agentState");
  });

  test.each([
    ["the run's default tier fast and its model", CLAUDE_TIERS, "fast", "claude-sonnet-5-5"],
    ["a null tier and model with no tiers", null, null, null],
  ])("SC132: a run that cannot switch models records %s", async (_label, tiers, tier, model) => {
    const plan = await compilePlan(DESIGN_THEN_LINT);
    const { run } = await advanceTiered(plan, withSession({ ...start(), tiers }), null);
    expect(run.state.nodeRuns.design?.agentState).toMatchObject({ tier, model });
  });
});

describe("decideNext with subagent mode", () => {
  test("SC1: a subagent node starts on its tier's model without switching the session", async () => {
    const plan = await compilePlan(`name: t
nodes:${stage("think", "thinker", "\n    mode: subagent\n    input: {}")}
`);
    const { stop, events, run } = await advanceTiered(plan, fresh(), FAST_AND_DEEP, HAIKU, true);
    expect(expectLeaf(stop).runsOn).toEqual({ mode: "subagent", tier: "deep" });
    expect(events.map((event) => event.type)).not.toContain("workflow.model.requested");
    expect(run.state.nodeRuns.think?.agentState).toMatchObject({ tier: "deep", model: "opus-x" });
  });

  test("SC2: a stage whose SKILL.md says subagent runs in a subagent when its node sets no mode", async () => {
    const plan = await compilePlan(`name: t
nodes:${stage("hand", "delegated", "\n    input: {}")}
`);
    const { stop } = await advanceTiered(plan, fresh(), FAST_AND_DEEP, HAIKU, true);
    expect(expectLeaf(stop).runsOn).toEqual({ mode: "subagent", tier: "deep" });
  });

  test("SC3: a node's mode: inline overrides its stage's subagent mode, and the session switches as before", async () => {
    const plan = await compilePlan(`name: t
nodes:${stage("hand", "delegated", "\n    mode: inline\n    input: {}")}
`);
    const { stop } = await advanceTiered(plan, fresh(), FAST_AND_DEEP, HAIKU, true);
    expect(stop).toEqual({ kind: "model", nodeId: "hand", model: "opus-x", effort: "high" });
  });

  test("SC4: an agent that cannot start subagents runs a subagent node inline", async () => {
    const plan = await compilePlan(`name: t
nodes:${stage("hand", "delegated", "\n    input: {}")}
`);
    const { stop } = await advanceTiered(plan, fresh(), null, null, false);
    expect(expectLeaf(stop).runsOn).toEqual({ mode: "inline", tier: null });
  });

  test("SC5: a subagent node on a run with no tiers carries no tier", async () => {
    const plan = await compilePlan(`name: t
nodes:${stage("hand", "delegated", "\n    input: {}")}
`);
    const { stop } = await advanceTiered(plan, fresh(), null, null, true);
    expect(expectLeaf(stop).runsOn).toEqual({ mode: "subagent", tier: null });
  });
});

const SWITCH = `name: t
inputs:
  kind: { type: string, required: true }
nodes:
  - id: decide
    type: switch
    expression: "{{ inputs.kind }}"
    input: {}
    cases:
      - id: a
        value: a
        nodes:
          - { id: one, type: exec, runtime: sh, script: "true", input: {} }
      - id: b
        value: b
        nodes:
          - { id: two, type: exec, runtime: sh, script: "true", input: {} }
  - id: after
    type: exec
    runtime: sh
    script: "true"
    dependsOn: [decide]
    input: "{{ nodes.decide.output }}"
`;

const loop = (until: string, maxIterations: number, extra = ""): string => `name: t
nodes:
  - id: fix
    type: loop
    until: "${until}"
    maxIterations: ${maxIterations}
    input: {}
    nodes:
      - { id: test, type: exec, runtime: sh, script: "true", input: "pass {{ iteration.index }}" }${extra}
`;

type Leaves = Readonly<{ state: State; inputs: readonly JsonValue[] }>;

// Hands out a leaf and ends it with each status in turn, as the skill would.
const runLeaves = async (
  plan: WorkflowPlan,
  state: State,
  statuses: readonly ("completed" | "failed")[],
  inputs: readonly JsonValue[] = [],
): Promise<Leaves> => {
  const [status, ...rest] = statuses;
  if (status === undefined) return { state, inputs };
  const next = await advance(plan, state);
  const leaf = expectLeaf(next.stop);
  const extra =
    status === "completed"
      ? { output: `out ${inputs.length + 1}` }
      : { error: { kind: "exit", message: "exited with code 1" } };
  const ended = end(next.state, leaf.nodeRunId, status, extra);
  return await runLeaves(plan, ended, rest, [...inputs, leaf.input]);
};

describe("decideNext with containers", () => {
  test("IW22 — a switch hands out only the matching case's node, records the case, and its output feeds what follows", async () => {
    const plan = await compilePlan(SWITCH);
    const first = await advance(plan, start({ kind: "b" }));
    const two = expectLeaf(first.stop);
    const decide = findRun(first.state, "decide");
    expect(two.node.id).toBe("two");
    expect(decide).toMatchObject({ status: "running", branch: "b" });
    expect(findRun(first.state, "decide", "two")?.nodeRunId).toBe(two.nodeRunId);

    const afterTwo = end(first.state, two.nodeRunId, "completed", { output: { x: 1 } });
    const next = await advance(plan, afterTwo);
    expect(expectLeaf(next.stop)).toMatchObject({ node: { id: "after" }, input: { x: 1 } });
    expect(findRun(next.state, "decide")).toMatchObject({
      status: "completed",
      output: { x: 1 },
    });
    expect(findRun(next.state, "decide", "one")).toBeUndefined();
  });

  test("IW23 — a switch with no matching case and no default is skipped, and so is what depends on it", async () => {
    const done = await advance(await compilePlan(SWITCH), start({ kind: "c" }));
    expect(done.stop).toEqual({ kind: "finished", status: "completed" });
    expect(findRun(done.state, "decide")).toMatchObject({
      status: "skipped",
      output: {
        reason: "no-matching-case",
        proof: { expression: "{{ inputs.kind }}", value: "c" },
      },
    });
    expect(findRun(done.state, "after")).toMatchObject({
      status: "skipped",
      output: { reason: "dependency-skipped", proof: { dependencies: ["decide"] } },
    });
  });

  test("IW43 — a switch's output is null when the last node of its case did not complete", async () => {
    const plan = await compilePlan(`name: t
nodes:
  - id: decide
    type: switch
    expression: "{{ 'go' }}"
    input: {}
    cases:
      - id: go
        value: go
        nodes:
          - { id: one, type: exec, runtime: sh, script: "true", input: {} }
          - { id: two, type: exec, runtime: sh, script: "true", when: "{{ false }}", input: {} }
`);
    const first = await advance(plan, start());
    const one = expectLeaf(first.stop);
    const done = await advance(plan, end(first.state, one.nodeRunId, "completed", { output: 1 }));
    expect(findRun(done.state, "decide")).toMatchObject({ status: "completed", output: null });
  });

  test("IW24 — a loop runs its body one pass at a time until until holds, and state keeps only the current pass", async () => {
    const plan = await compilePlan(loop("{{ iteration.index >= 3 }}", 5));
    const { state, inputs } = await runLeaves(plan, start(), ["completed", "completed"]);
    expect(inputs).toEqual(["pass 1", "pass 2"]);
    const third = await advance(plan, state);
    expect(expectLeaf(third.stop).input).toBe("pass 3");
    expect(findRun(third.state, "fix")).toMatchObject({
      status: "running",
      iteration: 3,
      output: "out 2",
    });
    expect(Object.keys(findRun(third.state, "fix")?.nodes ?? {})).toEqual(["test"]);
    expect(findRun(third.state, "fix", "test")).toMatchObject({
      status: "running",
      input: "pass 3",
    });

    const finished = end(third.state, expectLeaf(third.stop).nodeRunId, "completed", {
      output: "out 3",
    });
    const done = await advance(plan, finished);
    expect(done.stop).toEqual({ kind: "finished", status: "completed" });
    expect(findRun(done.state, "fix")).toMatchObject({
      status: "completed",
      iteration: 3,
      output: "out 3",
    });
  });

  test("IW44 — a loop's output, and so iteration.previous, is the output of the last node in its body", async () => {
    const report = `
      - { id: report, type: exec, runtime: sh, script: "true", dependsOn: [test], input: "{{ iteration.previous }}" }`;
    const plan = await compilePlan(loop("{{ iteration.index >= 2 }}", 3, report));
    const firstPass = await runLeaves(plan, start(), ["completed", "completed"]);
    const second = await advance(plan, firstPass.state);
    expect(second.events).toContainEqual(
      expect.objectContaining({
        type: "workflow.node.iterated",
        payload: expect.objectContaining({ output: "out 2" }),
      }),
    );
    const { state, inputs } = await runLeaves(plan, firstPass.state, ["completed", "completed"]);
    expect(inputs).toEqual(["pass 2", "out 2"]);
    const done = await advance(plan, state);
    expect(findRun(done.state, "fix")).toMatchObject({ status: "completed", output: "out 2" });
  });

  test("SC310: a body node interrupted in pass 2 is handed out again in pass 2, and the pass's finished node is kept", async () => {
    const report = `
      - { id: report, type: exec, runtime: sh, script: "true", dependsOn: [test], input: "{{ iteration.previous }}" }`;
    const plan = await compilePlan(loop("{{ iteration.index >= 3 }}", 3, report));
    const { state } = await runLeaves(plan, start(), ["completed", "completed", "completed"]);
    const reportRun = await advance(plan, state);
    const first = expectLeaf(reportRun.stop);
    expect(first.node.id).toBe("report");
    const testRun = findRun(reportRun.state, "fix", "test");

    const again = await advance(plan, end(reportRun.state, first.nodeRunId, "interrupted"));
    const retried = expectLeaf(again.stop);
    expect(retried.node.id).toBe("report");
    expect(retried.nodeRunId).not.toBe(first.nodeRunId);
    expect(retried.input).toBe("out 2");
    expect(findRun(again.state, "fix")).toMatchObject({ status: "running", iteration: 2 });
    expect(findRun(again.state, "fix", "test")).toEqual(testRun);
  });

  test("IW45 — a loop whose last body node did not complete hands null to its next pass", async () => {
    const plan = await compilePlan(`name: t
nodes:
  - id: fix
    type: loop
    until: "{{ iteration.index >= 2 }}"
    maxIterations: 3
    input: {}
    nodes:
      - { id: test, type: exec, runtime: sh, script: "true", input: "{{ iteration.previous }}" }
      - { id: tail, type: exec, runtime: sh, script: "true", when: "{{ false }}", input: {} }
`);
    const firstPass = await runLeaves(plan, start(), ["completed"]);
    const second = await advance(plan, firstPass.state);
    expect(second.events).toContainEqual(
      expect.objectContaining({
        type: "workflow.node.iterated",
        payload: expect.objectContaining({ output: null }),
      }),
    );
    expect(expectLeaf(second.stop).input).toBeNull();
  });

  test("IW46 — a loop's body and its until read iteration.max as the loop's maxIterations", async () => {
    const plan = await compilePlan(
      loop("{{ iteration.index == iteration.max }}", 2).replace(
        'input: "pass {{ iteration.index }}"',
        'input: "pass {{ iteration.index }} of {{ iteration.max }}"',
      ),
    );
    const { state, inputs } = await runLeaves(plan, start(), ["completed", "completed"]);
    expect(inputs).toEqual(["pass 1 of 2", "pass 2 of 2"]);
    const done = await advance(plan, state);
    expect(done.stop).toEqual({ kind: "finished", status: "completed" });
  });

  test("IW25 — a loop whose until never holds fails as exhausted after maxIterations passes", async () => {
    const plan = await compilePlan(loop("{{ false }}", 2));
    const { state, inputs } = await runLeaves(plan, start(), ["completed", "completed"]);
    expect(inputs).toHaveLength(2);
    expect((await advance(plan, state)).events[0]).toMatchObject({
      type: "workflow.node.failed",
      nodeId: "fix",
      payload: { error: { kind: "exhausted" } },
    });
    expect((await advance(plan, state)).stop).toEqual({ kind: "finished", status: "failed" });
  });

  test("IW41 — a loop whose until cannot be worked out fails with a resolution error", async () => {
    const plan = await compilePlan(loop("{{ iteration.nodes.test.output.x.y }}", 3));
    const { state } = await runLeaves(plan, start(), ["completed"]);
    const done = await advance(plan, state);
    expect(done.stop).toEqual({ kind: "finished", status: "failed" });
    expect(done.events[0]).toMatchObject({
      type: "workflow.node.failed",
      nodeId: "fix",
      payload: { error: { kind: "resolution" } },
    });
  });

  test("IW26 — a failure in a loop pass fails the loop, starts no further pass, and stops the run", async () => {
    const other = `
  - { id: other, type: exec, runtime: sh, script: "true", input: {} }`;
    const plan = await compilePlan(loop("{{ iteration.index >= 3 }}", 5, other));
    const { state } = await runLeaves(plan, start(), ["failed"]);
    const done = await advance(plan, state);
    expect(done.stop).toEqual({ kind: "finished", status: "failed" });
    expect(findRun(done.state, "fix")?.status).toBe("failed");
    expect(findRun(done.state, "fix")?.iteration).toBe(1);
    expect(findRun(done.state, "fix", "test")?.status).toBe("failed");
    expect(findRun(done.state, "other")).toBeUndefined();
  });

  test("SC7: after a fails in pass 1, the always: true body node b is handed out, then the loop ends failed with no pass 2 and so does the run", async () => {
    const report = `
      - { id: report, type: exec, runtime: sh, script: "true", always: true, dependsOn: [test], input: "pass {{ iteration.index }}" }`;
    const plan = await compilePlan(loop("{{ iteration.index >= 3 }}", 5, report));
    const { state } = await runLeaves(plan, start(), ["failed"]);
    const second = await advance(plan, state);
    expect(expectLeaf(second.stop)).toMatchObject({ node: { id: "report" }, input: "pass 1" });
    const ended = end(second.state, expectLeaf(second.stop).nodeRunId, "completed", { output: {} });
    const done = await advance(plan, ended);
    expect(done.stop).toEqual({ kind: "finished", status: "failed" });
    expect(findRun(done.state, "fix")).toMatchObject({ status: "failed", iteration: 1 });
    expect(findRun(done.state, "fix", "test")?.status).toBe("failed");
    expect(findRun(done.state, "fix", "report")?.status).toBe("completed");
  });

  test("a failed body node with allowFailure does not fail its loop", async () => {
    const source = loop("{{ iteration.index >= 1 }}", 3).replace(
      'script: "true", input',
      'script: "true", allowFailure: true, input',
    );
    const plan = await compilePlan(source);
    const { state } = await runLeaves(plan, start(), ["failed"]);
    const done = await advance(plan, state);
    expect(done.stop).toEqual({ kind: "finished", status: "completed" });
    expect(findRun(done.state, "fix")?.status).toBe("completed");
    expect(findRun(done.state, "fix", "test")?.status).toBe("failed");
  });

  test("an allowed failure in a loop body does not hide an ordinary failure after it: the loop fails", async () => {
    const source = loop("{{ iteration.index >= 1 }}", 3).replace(
      'script: "true", input: "pass {{ iteration.index }}" }',
      'script: "true", allowFailure: true, input: {} }\n      - { id: check, type: exec, runtime: sh, script: "true", input: {} }',
    );
    const plan = await compilePlan(source);
    const { state } = await runLeaves(plan, start(), ["failed", "failed"]);
    const done = await advance(plan, state);
    expect(done.stop).toEqual({ kind: "finished", status: "failed" });
    expect(findRun(done.state, "fix")?.status).toBe("failed");
  });

  test("a container with allowFailure ends failed when a child fails, and the run goes on and completes", async () => {
    const other = `
  - { id: other, type: exec, runtime: sh, script: "true", input: {} }`;
    const source = loop("{{ iteration.index >= 1 }}", 3, other).replace(
      "    maxIterations",
      "    allowFailure: true\n    maxIterations",
    );
    const plan = await compilePlan(source);
    const { state } = await runLeaves(plan, start(), ["failed", "completed"]);
    const done = await advance(plan, state);
    expect(done.stop).toEqual({ kind: "finished", status: "completed" });
    expect(findRun(done.state, "fix")?.status).toBe("failed");
    expect(findRun(done.state, "other")?.status).toBe("completed");
  });

  test("SC515: an allowFailure loop whose allowFailure child fails with needs-input fails with needs-input, after never starts, and the run ends failed", async () => {
    const after = `
  - { id: after, type: exec, runtime: sh, script: "true", input: {} }`;
    const source = loop("{{ iteration.index >= 1 }}", 3, after)
      .replace("    maxIterations", "    allowFailure: true\n    maxIterations")
      .replace('script: "true", input: "pass', 'script: "true", allowFailure: true, input: "pass');
    const plan = await compilePlan(source);
    const first = await advance(plan, start());
    const failed = end(first.state, expectLeaf(first.stop).nodeRunId, "failed", {
      error: { kind: "needs-input", message: "Which region?" },
    });
    const done = await advance(plan, failed);
    expect(done.stop).toEqual({ kind: "finished", status: "failed" });
    expect(findRun(done.state, "fix")).toMatchObject({
      status: "failed",
      output: { kind: "needs-input" },
    });
    expect(findRun(done.state, "after")).toBeUndefined();
  });

  test("IW27 —an include runs the included workflow with its defaults applied, and fails at start on a wrong-typed input", async () => {
    const child = `name: child
inputs:
  word: { type: string, default: hi }
nodes:
  - { id: say, type: exec, runtime: sh, script: "true", input: "{{ inputs.word }}" }
`;
    const main = (input: string) => `name: t
nodes:
  - { id: sub, type: include, workflow: child.yml, input: ${input} }
`;
    const plan = await compilePlan(main("{}"), { "child.yml": child });
    const first = await advance(plan, start());
    const say = expectLeaf(first.stop);
    expect(say).toMatchObject({ node: { id: "say" }, input: "hi" });
    expect(findRun(first.state, "sub", "say")?.nodeRunId).toBe(say.nodeRunId);

    const bad = await compilePlan(main("{ word: 3 }"), { "child.yml": child });
    expect((await advance(bad, start())).events[0]).toMatchObject({
      type: "workflow.node.failed",
      nodeId: "sub",
      payload: { error: { kind: "validation" } },
    });
    const done = await advance(bad, start());
    expect(done.stop).toEqual({ kind: "finished", status: "failed" });
    expect(findRun(done.state, "sub", "say")).toBeUndefined();
  });
});

// outer holds inner, then f; inner holds the producer stage x, then the consumer stage y after it.
const NESTED = `name: t
nodes:
  - id: outer
    type: switch
    expression: "{{ 'go' }}"
    input: {}
    cases:
      - id: go
        value: go
        nodes:
          - id: inner
            type: switch
            expression: "{{ 'go' }}"
            input: {}
            cases:
              - id: go
                value: go
                nodes:
                  - { id: x, type: agent, stage: stages/producer, input: {} }
                  - { id: y, type: agent, stage: stages/consumer, dependsOn: [x], input: {} }
          - { id: f, type: exec, runtime: sh, script: "true", input: {} }
`;

describe("decideNext inside nested containers", () => {
  test("IW29 — a blocked stage deep inside containers stops the run: f, which does not depend on it, never starts", async () => {
    const plan = await compilePlan(NESTED);
    const first = await advance(plan, start());
    const x = expectLeaf(first.stop);
    const second = await advance(plan, end(first.state, x.nodeRunId, "completed", { output: {} }));
    expect(second.stop).toEqual({
      kind: "blocked",
      nodeId: "y",
      stage: "stages/consumer",
      missing: ["plan"],
    });
    expect(findRun(second.state, "outer", "f")).toBeUndefined();
  });

  test("IW35 — a failure inside a nested container fails it and every container around it, and nothing after it starts", async () => {
    const plan = await compilePlan(NESTED);
    const first = await advance(plan, start());
    const x = expectLeaf(first.stop);
    const error = { kind: "exit", message: "exited with code 1" };
    const done = await advance(plan, end(first.state, x.nodeRunId, "failed", { error }));
    expect(done.stop).toEqual({ kind: "finished", status: "failed" });
    expect(findRun(done.state, "outer", "inner", "y")).toBeUndefined();
    expect(findRun(done.state, "outer", "inner")?.status).toBe("failed");
    expect(findRun(done.state, "outer", "f")).toBeUndefined();
    expect(findRun(done.state, "outer")?.status).toBe("failed");
  });
});

// A switch on `inputs.value` with a case for the number 1 and a default.
const TYPED_SWITCH = `name: t
inputs:
  value: { type: object, required: true }
nodes:
  - id: decide
    type: switch
    expression: "{{ inputs.value.v }}"
    input: {}
    cases:
      - id: one
        value: 1
        nodes:${exec("a", "\n    input: {}").replaceAll("\n  ", "\n          ")}
    default:${exec("other", "\n    input: {}").replaceAll("\n  ", "\n      ")}
`;

describe("decideNext on inputs, when and switch values", () => {
  test("IW36 — workflow inputs get their defaults, and inputs that break their declarations are refused", async () => {
    const plan = await compilePlan(`name: t
inputs:
  name: { type: string, required: true }
  count: { type: number, default: 2 }
nodes:${exec("show", '\n    input: "{{ inputs }}"')}
`);
    expect(expectLeaf((await advance(plan, start({ name: "x" }))).stop).input).toEqual({
      name: "x",
      count: 2,
    });
    for (const [input, named] of [
      [{}, "name"],
      [{ name: 5 }, "name"],
      [{ name: "x", extra: 1 }, "extra"],
    ] as const) {
      await expect(advance(plan, start(input))).rejects.toThrow(named);
    }
  });

  test("IW37 — a when that is not a boolean fails the node at start instead of skipping it", async () => {
    const plan = await compilePlan(`name: t
inputs:
  name: { type: string, required: true }
nodes:${exec("a", '\n    when: "{{ inputs.name }}"\n    input: {}')}
`);
    expect((await advance(plan, start({ name: "x" }))).events[0]).toMatchObject({
      type: "workflow.node.failed",
      payload: { error: { kind: "resolution" } },
    });
  });

  test("IW38 — case values match by type as well as by value: the string '1' takes the default", async () => {
    const plan = await compilePlan(TYPED_SWITCH);
    expect(expectLeaf((await advance(plan, start({ value: { v: 1 } }))).stop).node.id).toBe("a");
    expect(expectLeaf((await advance(plan, start({ value: { v: "1" } }))).stop).node.id).toBe(
      "other",
    );
  });

  test("IW39 — a switch expression that is missing or not a scalar fails the switch at start", async () => {
    const plan = await compilePlan(TYPED_SWITCH);
    for (const value of [{}, { v: { a: 1 } }]) {
      const done = await advance(plan, start({ value }));
      expect(done.stop).toEqual({ kind: "finished", status: "failed" });
      expect(findRun(done.state, "decide")?.status).toBe("failed");
      expect(findRun(done.state, "decide", "a")).toBeUndefined();
    }
  });

  test("IW40 — nodes named after Object.prototype keys still run", async () => {
    const plan = await compilePlan(`name: t
nodes:${exec("toString", "\n    input: {}")}${exec("hasOwnProperty", "\n    dependsOn: [toString]\n    input: {}")}
`);
    const first = await advance(plan, start());
    expect(expectLeaf(first.stop).node.id).toBe("toString");
    const afterFirst = end(first.state, expectLeaf(first.stop).nodeRunId, "completed", {
      output: {},
    });
    expect(expectLeaf((await advance(plan, afterFirst)).stop).node.id).toBe("hasOwnProperty");
  });
});

const CONTEXT_FLOW = `name: t
nodes:
  - { id: first, type: agent, prompt: one, input: {} }
  - { id: fresh, type: context, action: new, dependsOn: [first] }
  - { id: second, type: agent, prompt: two, dependsOn: [fresh], input: {} }
`;

describe("context node", () => {
  test("next hands out a context node as a step, then the node after it once it completes", async () => {
    const plan = await compilePlan(CONTEXT_FLOW);
    const first = await advance(plan, start());
    const afterFirst = end(first.state, expectLeaf(first.stop).nodeRunId, "completed", {
      output: {},
    });

    const context = expectContext((await advance(plan, afterFirst)).stop);
    expect(context.node).toMatchObject({ id: "fresh", type: "context", action: "new" });

    const handed = await advance(plan, afterFirst);
    const afterContext = end(handed.state, expectContext(handed.stop).nodeRunId, "completed", {
      output: { action: "new", sessionId: "B" },
    });
    expect(expectLeaf((await advance(plan, afterContext)).stop).node.id).toBe("second");
  });

  test("a context node in a loop is handed out again on every pass", async () => {
    const plan = await compilePlan(`name: t
nodes:
  - id: fix
    type: loop
    until: "{{ iteration.index >= 2 }}"
    maxIterations: 3
    input: {}
    nodes:
      - { id: slim, type: context, action: compact }
`);
    const ids: string[] = [];
    let state = start();
    for (let pass = 0; pass < 2; pass++) {
      const handed = await advance(plan, state);
      const leaf = expectContext(handed.stop);
      expect(leaf.node).toMatchObject({ id: "slim", action: "compact" });
      ids.push(leaf.nodeRunId);
      state = end(handed.state, leaf.nodeRunId, "completed", { output: {} });
    }
    expect(new Set(ids).size).toBe(2);
  });
});

describe("the shipped task workflow's qa and review loops", () => {
  const TASK_WORKFLOW = join(import.meta.dir, "..", "..", "..", "..", "workflows", "task.yaml");
  const bug = {
    id: "SC1",
    summary: "the total skips refunds",
    trigger: "check out with a refund",
    hint: "subtract refunds",
  };
  const report = "artifacts/verification/proof-report.html";
  const VERDICTS: Readonly<Record<string, JsonObject>> = {
    PASS: { status: "PASS", report, gaps: [], bugs: [] },
    PARTIAL: { status: "PARTIAL", reason: "SC2 not verified", report, gaps: [], bugs: [] },
    FAIL: {
      status: "FAIL",
      reason: "SC1 failed",
      report: null,
      gaps: [],
      bugs: [{ ...bug, askUser: false }],
    },
    BLOCKED: { status: "BLOCKED", reason: "no environment", report: null, gaps: [], bugs: [] },
  };
  const workspace = { path: "/work/ws" };
  const OUTPUTS: Readonly<Record<string, JsonObject>> = {
    "ticket-fetcher": { task: "do X" },
    "create-workspace": workspace,
  };
  const APPROVED: JsonObject = {
    verdict: "APPROVED",
    report: "artifacts/review.md",
    reviewed: { yok: "b2" },
    findings: [],
  };
  // Every artifact a stage in task.yaml consumes, listed on each finished node so none is blocked.
  const artifacts = ["design", "plan", "implementation"].map((name) => ({
    type: name,
    name,
    path: `artifacts/${name}.md`,
  }));

  type Handed = Readonly<{
    id: string;
    node: Leaf;
    input: JsonValue;
    variables: Readonly<Record<string, string>>;
  }>;
  // sizes: how many nodes each `next` handed out
  type Walked = Readonly<{
    state: State;
    stop: Stop;
    handed: readonly Handed[];
    sizes: readonly number[];
  }>;

  type Answers = Readonly<{ qa?: readonly string[]; review?: readonly JsonObject[] }>;

  // Walks task.yaml as the session would, answering each qa pass with the next verdict and each
  // code-review pass with the next review (PASS and APPROVED once they run out), and keeps every
  // leaf it was handed. Nodes named in `failing` end failed.
  const walkTask = async (
    plan: WorkflowPlan,
    state: State,
    answers: Answers,
    failing: readonly string[] = [],
    handed: readonly Handed[] = [],
    sizes: readonly number[] = [],
  ): Promise<Walked> => {
    const next = await advance(plan, state);
    const { stop } = next;
    if (stop.kind !== "steps" && stop.kind !== "context") {
      return { state: next.state, stop, handed, sizes };
    }
    const size = stop.kind === "steps" ? stop.steps.length : 1;
    const [first] = stop.kind === "steps" ? stop.steps : [{ ...stop, input: null, variables: {} }];
    if (first === undefined) throw new Error("a steps reply with no steps");
    const { node, nodeRunId, input, variables } = first;
    const { qa = [], review = [] } = answers;
    const output =
      node.id === "qa"
        ? (VERDICTS[qa[0] ?? "PASS"] ?? null)
        : node.id === "code-review"
          ? (review[0] ?? APPROVED)
          : (OUTPUTS[node.id] ?? {});
    const ended = failing.includes(node.id)
      ? end(next.state, nodeRunId, "failed", {
          nodeType: "agent",
          error: { kind: "exit", message: "the retro sub-agent failed" },
        })
      : end(next.state, nodeRunId, "completed", { nodeType: "agent", output, artifacts });
    const rest = {
      qa: node.id === "qa" ? qa.slice(1) : qa,
      review: node.id === "code-review" ? review.slice(1) : review,
    };
    return walkTask(
      plan,
      ended,
      rest,
      failing,
      [...handed, { id: node.id, node, input, variables }],
      [...sizes, size],
    );
  };

  const loopIds = (handed: readonly Handed[]): readonly string[] =>
    handed.map(({ id }) => id).filter((id) => ["qa", "fix", "retro"].includes(id));

  // The review loop's leaves: its code-review and fix, all handed out before the qa loop starts.
  const reviewLeaves = (handed: readonly Handed[]): readonly Handed[] => {
    const qaStart = handed.findIndex(({ id }) => id === "qa");
    const beforeQa = qaStart === -1 ? handed : handed.slice(0, qaStart);
    return beforeQa.filter(({ id }) => id === "code-review" || id === "fix");
  };

  test("SC13: a first PASS hands out every stage in order in the run's workspace, runs qa once as round 1 of 4, and its verdict is the loop's output", async () => {
    const { state, stop, handed } = await walkTask(
      await compileWorkflow(TASK_WORKFLOW),
      start({ prompt: "p" }),
      { qa: ["PASS"] },
    );

    const task = "do X";
    expect(handed).toMatchObject([
      { id: "ticket-fetcher", input: { request: "p" }, variables: { provider: "auto" } },
      { id: "create-workspace", input: { request: task } },
      { id: "baseline", input: {} },
      { id: "design", input: { task } },
      { id: "planning", input: { task, workspace } },
      { id: "learn" },
      { id: "compact-after-planning", node: { type: "context", action: "compact" } },
      { id: "implement", input: { workspace } },
      { id: "compact-after-implement", node: { type: "context", action: "compact" } },
      { id: "code-review", input: { workspace } },
      { id: "compact-after-review", node: { type: "context", action: "compact" } },
      {
        id: "qa",
        input: { workspace, task, round: 1, rounds: 4 },
        variables: { environment: "default" },
      },
      { id: "commit", input: { workspace } },
      { id: "pr", input: { workspace, task, qa: VERDICTS.PASS } },
      { id: "retro", input: {} },
    ]);
    expect(handed.find(({ id }) => id === "pr")?.input).toEqual({
      workspace,
      task,
      qa: VERDICTS.PASS ?? null,
    });
    expect(findRun(state, "qa-loop")).toMatchObject({ status: "completed", output: VERDICTS.PASS });
    expect(stop).toEqual({ kind: "finished", status: "completed" });
  });

  test("SC3: a qa loop that ends PARTIAL after a FAIL hands pr the PARTIAL verdict as its qa input", async () => {
    const { stop, handed } = await walkTask(
      await compileWorkflow(TASK_WORKFLOW),
      start({ prompt: "p" }),
      { qa: ["FAIL", "PARTIAL"] },
    );

    const ids = handed.map(({ id }) => id);
    expect(ids.indexOf("pr")).toBeGreaterThan(ids.indexOf("commit"));
    expect(ids.indexOf("commit")).toBeGreaterThan(-1);
    expect(handed.find(({ id }) => id === "pr")?.input).toEqual({
      workspace,
      task: "do X",
      qa: VERDICTS.PARTIAL ?? null,
    });
    expect(stop).toEqual({ kind: "finished", status: "completed" });
  });

  test("SC14 (review-loop SC5): a FAIL hands fix its bugs as fixes for qa round 2, then qa runs again as round 2", async () => {
    const { state, handed } = await walkTask(
      await compileWorkflow(TASK_WORKFLOW),
      start({ prompt: "p" }),
      { qa: ["FAIL", "PARTIAL"] },
    );

    expect(loopIds(handed)).toEqual(["qa", "fix", "qa", "retro"]);
    expect(handed.find(({ id }) => id === "fix")?.input).toEqual({
      workspace,
      fixes: [{ ...bug, askUser: false }],
      source: "qa",
      round: 2,
    });
    expect(handed.filter(({ id }) => id === "qa")[1]?.input).toMatchObject({ round: 2, rounds: 4 });
    expect(handed.find(({ id }) => id === "fix")?.node).toMatchObject({ stage: { ref: "fix" } });
    expect(findRun(state, "qa-loop")).toMatchObject({
      status: "completed",
      output: VERDICTS.PARTIAL,
    });
  });

  test("SC15, SC18: four FAILs fail the loop on its fourth pass after three fix rounds; retro still runs with input {}, commit and pr never start, and the run fails", async () => {
    const { state, stop, handed } = await walkTask(
      await compileWorkflow(TASK_WORKFLOW),
      start({ prompt: "p" }),
      { qa: ["FAIL", "FAIL", "FAIL", "FAIL"] },
    );

    expect(loopIds(handed)).toEqual(["qa", "fix", "qa", "fix", "qa", "fix", "qa", "retro"]);
    expect(findRun(state, "qa-loop")).toMatchObject({
      status: "failed",
      iteration: 4,
    });
    expect(handed.at(-1)).toMatchObject({ id: "retro", input: {} });
    expect(findRun(state, "retro")?.status).toBe("completed");
    expect(findRun(state, "commit")).toBeUndefined();
    expect(findRun(state, "pr")).toBeUndefined();
    expect(stop).toEqual({ kind: "finished", status: "failed" });
  });

  test("a qa loop that ends BLOCKED skips the commit gated on its verdict and the pr after it, while retro still runs", async () => {
    const { state, stop, handed } = await walkTask(
      await compileWorkflow(TASK_WORKFLOW),
      start({ prompt: "p" }),
      { qa: ["BLOCKED"] },
    );

    expect(loopIds(handed)).toEqual(["qa", "retro"]);
    expect(findRun(state, "commit")).toMatchObject({
      status: "skipped",
      output: { reason: "when-false" },
    });
    expect(findRun(state, "pr")).toMatchObject({
      status: "skipped",
      output: { reason: "dependency-skipped", proof: { dependencies: ["commit"] } },
    });
    expect(stop).toEqual({ kind: "finished", status: "completed" });
  });

  test("SC19: on a passing run retro is the last node handed out, and its failure leaves the run completed", async () => {
    const { state, stop, handed } = await walkTask(
      await compileWorkflow(TASK_WORKFLOW),
      start({ prompt: "p" }),
      { qa: ["PASS"] },
      ["retro"],
    );

    expect(loopIds(handed)).toEqual(["qa", "retro"]);
    expect(findRun(state, "pr")?.status).toBe("completed");
    expect(findRun(state, "retro")?.status).toBe("failed");
    expect(stop).toEqual({ kind: "finished", status: "completed" });
  });
  const finding = {
    id: "defects-1",
    axis: "defects",
    severity: "High",
    size: "small",
    file: "src/run.ts",
    summary: "runTask does not await the save",
    trigger: "a task finishes while the save is pending",
    hint: "await the save",
  };
  const CHANGES_REQUESTED: JsonObject = {
    verdict: "CHANGES_REQUESTED",
    report: "artifacts/review.md",
    reviewed: { yok: "a1" },
    findings: [finding],
  };

  test("SC13 (review-loop): a first CHANGES_REQUESTED hands fix its findings, then code-review runs as round 2, and APPROVED ends the loop", async () => {
    const { state, stop, handed } = await walkTask(
      await compileWorkflow(TASK_WORKFLOW),
      start({ prompt: "p" }),
      { review: [CHANGES_REQUESTED, APPROVED] },
    );

    const review = reviewLeaves(handed);
    expect(review.map(({ id }) => id)).toEqual(["code-review", "fix", "code-review"]);
    expect(review[1]?.node).toMatchObject({ stage: { ref: "fix" } });
    expect(findRun(state, "review-loop", "compact-before-fix")?.status).toBe("completed");
    expect(review[1]?.input).toEqual({
      workspace,
      fixes: [finding],
      source: "review",
      round: 2,
    });
    expect(review[2]?.input).toEqual({
      workspace,
      round: 2,
      rounds: 2,
      previous: CHANGES_REQUESTED,
    });
    expect(findRun(state, "review-loop")).toMatchObject({ status: "completed", output: APPROVED });
    expect(findRun(state, "qa-loop")?.status).toBe("completed");
    expect(stop).toEqual({ kind: "finished", status: "completed" });
  });

  test("SC14 (review-loop): two CHANGES_REQUESTED end the loop completed on its last pass, and the run goes on to qa", async () => {
    const { state, stop } = await walkTask(
      await compileWorkflow(TASK_WORKFLOW),
      start({ prompt: "p" }),
      { review: [CHANGES_REQUESTED, CHANGES_REQUESTED] },
    );

    expect(findRun(state, "review-loop")).toMatchObject({
      status: "completed",
      iteration: 2,
      output: CHANGES_REQUESTED,
    });
    expect(findRun(state, "qa-loop")?.status).toBe("completed");
    expect(stop).toEqual({ kind: "finished", status: "completed" });
  });

  test("SC15 (review-loop): a first APPROVED runs code-review once, as round 1, and never hands out fix", async () => {
    const { state, handed } = await walkTask(
      await compileWorkflow(TASK_WORKFLOW),
      start({ prompt: "p" }),
      { review: [APPROVED] },
    );

    const review = reviewLeaves(handed);
    expect(review.map(({ id }) => id)).toEqual(["code-review"]);
    expect(review[0]?.input).toEqual({ workspace, round: 1, rounds: 2, previous: null });
    expect(findRun(state, "review-loop", "compact-before-fix")?.status).toBe("skipped");
    expect(findRun(state, "review-loop", "fix")?.status).toBe("skipped");
  });

  test("SC3: on pass 1 of each loop, code-review and qa run after their skipped fix, not recorded dependency-skipped", async () => {
    const { state } = await walkTask(await compileWorkflow(TASK_WORKFLOW), start({ prompt: "p" }), {
      qa: ["PASS"],
      review: [APPROVED],
    });

    expect(findRun(state, "review-loop", "compact-before-fix")?.status).toBe("skipped");
    expect(findRun(state, "review-loop", "fix")?.status).toBe("skipped");
    expect(findRun(state, "review-loop", "code-review")?.status).toBe("completed");
    expect(findRun(state, "qa-loop", "fix")?.status).toBe("skipped");
    expect(findRun(state, "qa-loop", "qa")?.status).toBe("completed");
  });

  test("SC14 (regression): driven to the end through a fix round in each loop, task.yaml hands out exactly one node per next, in the order the file lists them", async () => {
    const { stop, handed, sizes } = await walkTask(
      await compileWorkflow(TASK_WORKFLOW),
      start({ prompt: "p" }),
      { review: [CHANGES_REQUESTED, APPROVED], qa: ["FAIL", "PASS"] },
    );

    expect(sizes.every((size) => size === 1)).toBe(true);
    expect(handed.map(({ id }) => id)).toEqual([
      "ticket-fetcher",
      "create-workspace",
      "baseline",
      "design",
      "planning",
      "learn",
      "compact-after-planning",
      "implement",
      "compact-after-implement",
      "code-review",
      "compact-before-fix",
      "fix",
      "code-review",
      "compact-after-review",
      "qa",
      "fix",
      "qa",
      "commit",
      "pr",
      "retro",
    ]);
    expect(stop).toEqual({ kind: "finished", status: "completed" });
  });
});

const startedIds = (events: readonly EmitInput[]): readonly (string | undefined)[] =>
  events.filter(({ type }) => type === "workflow.node.started").map(({ nodeId }) => nodeId);

describe("decideNext with parallel nodes", () => {
  test("a next whose second start fails to store interrupts the first, then fails, so no node is left running without a handout", async () => {
    const plan = await compilePlan(`name: t
nodes:${exec("a", "\n    input: {}")}${exec("b", "\n    dependsOn: [a]\n    input: {}")}${exec("c", "\n    dependsOn: [a]\n    input: {}")}
`);
    const first = await advance(plan, start());
    const events: EmitInput[] = [];
    let current = end(first.state, expectLeaf(first.stop).nodeRunId, "completed", { output: {} });
    const emit = async (state: State, event: EmitInput): Promise<State> => {
      if (event.type === "workflow.node.started" && event.nodeId === "c")
        throw new Error("disk full");
      events.push(event);
      current = apply(state, event);
      return current;
    };
    const models = {
      tiers: null,
      switching: { current: null, pending: null, failed: null },
      subagents: false,
      parallel: true,
    };
    await expect(decideNext(plan, current, emit, models)).rejects.toThrow("disk full");
    expect(events.map(({ type, nodeId }) => `${type}:${nodeId}`)).toEqual([
      "workflow.node.started:b",
      "workflow.node.interrupted:b",
    ]);
    expect(findRun(current, "b")?.status).toBe("interrupted");
    expect(stepIds((await advance(plan, current)).stop)).toEqual(["b", "c"]);
  });

  test("SC1: b and c, which both depend on the completed a, are handed out together by one next and start in that order", async () => {
    const plan = await compilePlan(`name: t
nodes:${exec("a", "\n    input: {}")}${exec("b", "\n    dependsOn: [a]\n    input: {}")}${stage("c", "delegated", "\n    dependsOn: [a]\n    input: {}")}
`);
    const first = await advance(plan, start(), { subagents: true });
    const afterA = end(first.state, expectLeaf(first.stop).nodeRunId, "completed", { output: {} });
    const second = await advance(plan, afterA, { subagents: true });
    expect(stepIds(second.stop)).toEqual(["b", "c"]);
    expect(findRun(second.state, "b")?.status).toBe("running");
    expect(findRun(second.state, "c")?.status).toBe("running");
    expect(startedIds(second.events)).toEqual(["b", "c"]);
  });

  test("SC2: b, with no dependsOn, waits while a runs and is handed out once a completes", async () => {
    const plan = await compilePlan(`name: t
nodes:${exec("a", "\n    input: {}")}${exec("b", "\n    input: {}")}
`);
    const first = await advance(plan, start());
    const waiting = await advance(plan, first.state);
    expect(waitingOn(waiting.stop)).toEqual(["a"]);
    expect(findRun(waiting.state, "b")).toBeUndefined();
    const afterA = end(first.state, expectLeaf(first.stop).nodeRunId, "completed", { output: {} });
    expect(stepIds((await advance(plan, afterA)).stop)).toEqual(["b"]);
  });

  test("SC4: b, whose dependsOn names a, is recorded dependency-skipped when a is skipped by its when", async () => {
    const plan = await compilePlan(`name: t
nodes:${exec("a", '\n    when: "{{ false }}"\n    input: {}')}${exec("b", "\n    dependsOn: [a]\n    input: {}")}
`);
    const done = await advance(plan, start());
    expect(findRun(done.state, "b")).toMatchObject({
      status: "skipped",
      output: { reason: "dependency-skipped", proof: { dependencies: ["a"] } },
    });
  });

  test("SC5: of x and y, two inline stages that depend on the completed a, next hands out x alone, waits on it, then hands out y", async () => {
    const plan = await compilePlan(`name: t
nodes:${exec("a", "\n    input: {}")}${stage("x", "plain", "\n    dependsOn: [a]\n    input: {}")}${stage("y", "plain", "\n    dependsOn: [a]\n    input: {}")}
`);
    const first = await advance(plan, start());
    const afterA = end(first.state, expectLeaf(first.stop).nodeRunId, "completed", { output: {} });
    const second = await advance(plan, afterA);
    const x = expectLeaf(second.stop);
    expect(x.node.id).toBe("x");
    expect(findRun(second.state, "y")).toBeUndefined();
    expect(waitingOn((await advance(plan, second.state)).stop)).toEqual(["x"]);
    const afterX = end(second.state, x.nodeRunId, "completed", { nodeType: "agent", output: {} });
    expect(stepIds((await advance(plan, afterX)).stop)).toEqual(["y"]);
  });

  test("SC7: context node c waits while b runs, then goes out alone once b ends", async () => {
    const plan = await compilePlan(`name: t
nodes:${exec("a", "\n    input: {}")}${exec("b", "\n    dependsOn: [a]\n    input: {}")}
  - { id: c, type: context, action: compact, dependsOn: [a] }
`);
    const first = await advance(plan, start());
    const afterA = end(first.state, expectLeaf(first.stop).nodeRunId, "completed", { output: {} });
    const second = await advance(plan, afterA);
    const b = expectLeaf(second.stop);
    expect(b.node.id).toBe("b");
    expect(findRun(second.state, "c")).toBeUndefined();
    expect(waitingOn((await advance(plan, second.state)).stop)).toEqual(["b"]);
    const afterB = end(second.state, b.nodeRunId, "completed", { output: {} });
    const third = await advance(plan, afterB);
    expect(expectContext(third.stop).node.id).toBe("c");
    expect(findRun(third.state, "c")?.status).toBe("running");
  });

  test("SC8: on a run on its fast model, the deep inline thinker waits while subagent s runs, and gets its model step once s ends", async () => {
    const plan = await compilePlan(`name: t
nodes:${exec("a", "\n    input: {}")}${stage("s", "delegated", "\n    dependsOn: [a]\n    input: {}")}${stage("thinker", "thinker", "\n    dependsOn: [a]\n    input: {}")}
`);
    const tiered = (run: Logged) => advanceTiered(plan, run, FAST_AND_DEEP, HAIKU, true);
    const first = await tiered(fresh());
    const afterA = end(first.run.state, expectLeaf(first.stop).nodeRunId, "completed", {
      output: {},
    });
    const second = await tiered({ ...first.run, state: afterA });
    const sub = expectLeaf(second.stop);
    expect(sub.node.id).toBe("s");
    expect(second.events.map(({ type }) => type)).not.toContain("workflow.model.requested");
    const afterS = end(second.run.state, sub.nodeRunId, "completed", {
      nodeType: "agent",
      output: {},
    });
    const third = await tiered({ ...second.run, state: afterS });
    expect(third.stop).toEqual({
      kind: "model",
      nodeId: "thinker",
      model: "opus-x",
      effort: "high",
    });
  });

  test("SC10: after a fails, retro (always, dependsOn the never-started b) is handed out, and the run then finishes failed", async () => {
    const plan = await compilePlan(`name: t
nodes:${exec("a", "\n    input: {}")}${exec("b", "\n    dependsOn: [a]\n    input: {}")}${exec("retro", "\n    always: true\n    dependsOn: [b]\n    input: {}")}
`);
    const first = await advance(plan, start());
    const failed = end(first.state, expectLeaf(first.stop).nodeRunId, "failed", {
      error: { kind: "exit", message: "exited with code 1" },
    });
    const second = await advance(plan, failed);
    expect(stepIds(second.stop)).toEqual(["retro"]);
    const ended = end(second.state, expectLeaf(second.stop).nodeRunId, "completed", { output: {} });
    expect((await advance(plan, ended)).stop).toEqual({ kind: "finished", status: "failed" });
  });

  test("SC10: after a fails while b runs, retro2 (always, dependsOn retro) waits until retro (always, dependsOn b) has run, and the run then finishes failed", async () => {
    const plan = await compilePlan(`name: t
nodes:${exec("s", "\n    input: {}")}${exec("a", "\n    dependsOn: [s]\n    input: {}")}${exec("b", "\n    dependsOn: [s]\n    input: {}")}${exec("retro", "\n    always: true\n    dependsOn: [b]\n    input: {}")}${exec("retro2", "\n    always: true\n    dependsOn: [retro]\n    input: {}")}
`);
    const first = await advance(plan, start());
    const afterS = end(first.state, expectLeaf(first.stop).nodeRunId, "completed", { output: {} });
    const second = await advance(plan, afterS);
    const [a, b] = expectSteps(second.stop);
    if (a === undefined || b === undefined) throw new Error("expected a and b");
    const error = { kind: "exit", message: "exited with code 1" };
    const afterA = end(second.state, a.nodeRunId, "failed", { error });
    expect(waitingOn((await advance(plan, afterA)).stop)).toEqual(["b"]);
    const third = await advance(plan, end(afterA, b.nodeRunId, "completed", { output: {} }));
    const retro = expectLeaf(third.stop);
    expect(retro.node.id).toBe("retro");
    const fourth = await advance(
      plan,
      end(third.state, retro.nodeRunId, "completed", { output: {} }),
    );
    const retro2 = expectLeaf(fourth.stop);
    expect(retro2.node.id).toBe("retro2");
    const done = await advance(
      plan,
      end(fourth.state, retro2.nodeRunId, "completed", { output: {} }),
    );
    expect(done.stop).toEqual({ kind: "finished", status: "failed" });
  });

  test("SC11: on a run that cannot run nodes in parallel, b and c, which both depend on the completed a, go out one per next", async () => {
    const plan = await compilePlan(`name: t
nodes:${exec("a", "\n    input: {}")}${exec("b", "\n    dependsOn: [a]\n    input: {}")}${exec("c", "\n    dependsOn: [a]\n    input: {}")}
`);
    const serial = { parallel: false };
    const first = await advance(plan, start(), serial);
    const afterA = end(first.state, expectLeaf(first.stop).nodeRunId, "completed", { output: {} });
    const second = await advance(plan, afterA, serial);
    const b = expectLeaf(second.stop);
    expect(b.node.id).toBe("b");
    expect(findRun(second.state, "c")).toBeUndefined();
    expect(waitingOn((await advance(plan, second.state, serial)).stop)).toEqual(["b"]);
    const afterB = end(second.state, b.nodeRunId, "completed", { output: {} });
    expect(stepIds((await advance(plan, afterB, serial)).stop)).toEqual(["c"]);
  });

  test("SC9: a loop pass does not end while t, one of its children, still runs: next waits and records no completed or iterated event, then the loop completes once t does", async () => {
    const plan = await compilePlan(`name: t
nodes:
  - id: fix
    type: loop
    until: "{{ iteration.index >= 1 }}"
    maxIterations: 2
    input: {}
    nodes:
      - { id: x, type: exec, runtime: sh, script: "true", input: {} }
      - { id: r, type: agent, stage: stages/delegated, dependsOn: [x], input: {} }
      - { id: t, type: exec, runtime: sh, script: "true", dependsOn: [x], input: {} }
`);
    const models = { subagents: true };
    const first = await advance(plan, start(), models);
    const afterX = end(first.state, expectLeaf(first.stop).nodeRunId, "completed", { output: {} });
    const second = await advance(plan, afterX, models);
    const [r, t] = expectSteps(second.stop);
    if (r === undefined || t === undefined) throw new Error("expected r and t");
    const afterR = end(second.state, r.nodeRunId, "completed", { nodeType: "agent", output: {} });
    const waiting = await advance(plan, afterR, models);
    expect(waitingOn(waiting.stop)).toEqual(["t"]);
    expect(waiting.events.map(({ type }) => type)).toEqual([]);
    const afterT = end(waiting.state, t.nodeRunId, "completed", { output: {} });
    const done = await advance(plan, afterT, models);
    expect(findRun(done.state, "fix")?.status).toBe("completed");
    expect(done.stop).toEqual({ kind: "finished", status: "completed" });
  });

  test.each([
    ["at the top level", []],
    ["inside an outer loop", ["o"]],
  ])(
    "a loop c running beside f, which fails, starts no new pass once its x completes: c ends failed, r (always, dependsOn c) is handed out, and the run ends failed (%s)",
    async (_, parents) => {
      const body = (pad: string) => `
${pad}- { id: s, type: exec, runtime: sh, script: "true", input: {} }
${pad}- id: c
${pad}  type: loop
${pad}  until: "{{ iteration.index >= 2 }}"
${pad}  maxIterations: 3
${pad}  dependsOn: [s]
${pad}  input: {}
${pad}  nodes:
${pad}    - { id: x, type: exec, runtime: sh, script: "true", input: {} }
${pad}- { id: f, type: exec, runtime: sh, script: "true", dependsOn: [s], input: {} }
${pad}- { id: r, type: exec, runtime: sh, script: "true", always: true, dependsOn: [c], input: {} }`;
      const outer = `
  - id: o
    type: loop
    until: "{{ iteration.index >= 1 }}"
    maxIterations: 1
    input: {}
    nodes:${body("      ")}`;
      const plan = await compilePlan(
        `name: t\nnodes:${parents.length === 0 ? body("  ") : outer}\n`,
      );
      const first = await advance(plan, start());
      const afterS = end(first.state, expectLeaf(first.stop).nodeRunId, "completed", {
        output: {},
      });
      const second = await advance(plan, afterS);
      const [x, f] = expectSteps(second.stop);
      if (x === undefined || f === undefined) throw new Error("expected x and f");
      const error = { kind: "exit", message: "exited with code 1" };
      const afterF = end(second.state, f.nodeRunId, "failed", { error });
      const third = await advance(plan, end(afterF, x.nodeRunId, "completed", { output: {} }));
      expect(findRun(third.state, ...parents, "c")).toMatchObject({
        status: "failed",
        iteration: 1,
      });
      const r = expectLeaf(third.stop);
      expect(r.node.id).toBe("r");
      const done = await advance(plan, end(third.state, r.nodeRunId, "completed", { output: {} }));
      expect(done.stop).toEqual({ kind: "finished", status: "failed" });
    },
  );

  test("SC16: s, a subagent stage, and x, an inline stage, handed out by one next record mode subagent and inline; the exec a records no mode", async () => {
    const plan = await compilePlan(`name: t
nodes:${exec("a", "\n    input: {}")}${stage("s", "delegated", "\n    dependsOn: [a]\n    input: {}")}${stage("x", "plain", "\n    dependsOn: [a]\n    input: {}")}
`);
    const models = { subagents: true };
    const first = await advance(plan, start(), models);
    const afterA = end(first.state, expectLeaf(first.stop).nodeRunId, "completed", { output: {} });
    const second = await advance(plan, afterA, models);
    expect(stepIds(second.stop)).toEqual(["s", "x"]);
    expect(findRun(second.state, "s")?.mode).toBe("subagent");
    expect(findRun(second.state, "x")?.mode).toBe("inline");
    expect(findRun(second.state, "a")).not.toHaveProperty("mode");
  });

  test("SC17: on a run that cannot start subagents, a stage set to mode: subagent records mode inline", async () => {
    const plan = await compilePlan(`name: t
nodes:${stage("s", "plain", "\n    mode: subagent\n    input: {}")}
`);
    const { state } = await advance(plan, start(), { subagents: false });
    expect(findRun(state, "s")?.mode).toBe("inline");
  });
});
