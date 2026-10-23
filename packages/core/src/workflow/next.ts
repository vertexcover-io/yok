import { randomBytes } from "node:crypto";
import {
  type EmitInput,
  eventError,
  type JsonValue,
  type NodeRun,
  type ResolvedTiers,
  type SkipOutput,
  type State,
  stackOf,
  type TierModel,
  tierLaunch,
} from "@yok/sdk";
import { findNodeRuns, isRunLive, type ModelSwitch, nodePath } from "@yok/sdk/internal";
import { z } from "zod";
import { type AgentMode, own } from "../stage.ts";
import { findConsumedArtifacts } from "./done.ts";
import {
  evaluateBoolean,
  evaluateScalar,
  type NodeResult,
  resolveValue,
  type Scope,
} from "./evaluate.ts";
import {
  type InputDeclarations,
  NodeFailure,
  type PlanAgentNode,
  type PlanContextNode,
  type PlanExecNode,
  type PlanIncludeNode,
  type PlanLoopNode,
  type PlanNode,
  type PlanStage,
  type PlanSwitchNode,
  type PlanWaitNode,
  type WorkflowAgent,
  WorkflowError,
  type WorkflowPlan,
} from "./types.ts";

export type Leaf = PlanExecNode | PlanWaitNode | PlanAgentNode | PlanContextNode;

// How the session runs an agent node, and the tier a subagent it starts runs on: null when inline
// or the run has no tiers.
export type RunsOn = Readonly<{ mode: AgentMode; tier: string | null }>;

// A leaf `next` started for the skill to run.
export type StartedLeaf = Readonly<{
  node: Exclude<Leaf, PlanContextNode>;
  nodeRunId: string;
  input: JsonValue;
  variables: Readonly<Record<string, string>>;
  // how an agent node runs; null for every other leaf
  runsOn: RunsOn | null;
}>;

// What `next` replies. The events it recorded on the way are already saved.
export type Decision =
  // othersRunning: a node started by an earlier `next` is still open
  | Readonly<{ kind: "steps"; steps: readonly StartedLeaf[]; othersRunning: boolean }>
  | Readonly<{ kind: "context"; node: PlanContextNode; nodeRunId: string }>
  | (Readonly<{ kind: "model"; nodeId: string }> & TierModel)
  | Readonly<{
      kind: "waiting";
      running: readonly Readonly<{ nodeRunId: string; nodeId: string }>[];
    }>
  | Readonly<{ kind: "blocked"; nodeId: string; stage: string; missing: readonly string[] }>
  | Readonly<{ kind: "finished"; status: Exclude<State["status"], "running" | "blocked"> }>;

// Saves one event and gives back the state with it applied.
export type Emit = (state: State, event: EmitInput) => Promise<State>;

// What walking a node or a list of nodes decided: stop with a reply that goes out alone, go on to
// the next node, or walk again from the top once a failed model switch has failed its stage.
// `started` holds the leaves the walk started on the way.
type Step =
  | Exclude<Decision, { kind: "steps" | "waiting" | "finished" }>
  | Readonly<{ kind: "continue" }>
  | Readonly<{ kind: "rewalk" }>
  // storing an event failed after this walk had started leaves; they are interrupted before it fails
  | Readonly<{ kind: "halted"; error: unknown }>;
type Walked = Readonly<{ state: State; step: Step; started: readonly StartedLeaf[] }>;

const CONTINUE: Step = { kind: "continue" };

// The run's tiers and where its model switches stand. tiers is null when the run's agent cannot
// switch models, so every node runs on the model it has. subagents is false when the run's agent
// cannot start subagents, so every node runs inline. parallel is false when it runs one node at a
// time.
export type ModelInputs = Readonly<{
  tiers: ResolvedTiers | null;
  switching: ModelSwitch;
  subagents: boolean;
  parallel: boolean;
}>;

const NO_MODELS: ModelInputs = {
  tiers: null,
  switching: { current: null, pending: null, failed: null },
  subagents: false,
  parallel: true,
};

// Where the walk is: the inputs its expressions read and, inside a loop, the current pass. root is
// the plan's top level, for finding every open leaf. draining is true inside a running container
// whose scope has failed: it starts nothing new and ends once its open children end.
type Walk = ModelInputs &
  Readonly<{
    emit: Emit;
    agent: WorkflowAgent;
    inputs: JsonValue;
    loop: Readonly<{ index: number; max: number; previous: JsonValue }> | undefined;
    root: readonly PlanNode[];
    draining: boolean;
  }>;

// Top-level nodes carry no `parents`; state.json puts them at the root of its tree.
export const buildParentsField = (parents: readonly string[]) =>
  parents.length === 0 ? {} : { parents: [...parents] };

const createNodeRunId = (): string => `nr-${randomBytes(8).toString("hex")}`;

type Container = Exclude<PlanNode, Leaf>;

const LEAF_TYPES: ReadonlySet<PlanNode["type"]> = new Set(["exec", "wait", "agent", "context"]);
const isLeaf = (node: PlanNode): node is Leaf => LEAF_TYPES.has(node.type);

const findNodeRun = (state: State, node: PlanNode): NodeRun | undefined =>
  own(findNodeRuns(state.nodeRuns, node.parents), node.id);

// The nodes a running container holds now: a loop's body, the included workflow, or the case
// the switch took.
const pickChildren = (node: Container, nodeRun: NodeRun): readonly PlanNode[] => {
  if (node.type === "loop") return node.nodes;
  if (node.type === "include") return node.plan.nodes;
  if (nodeRun.branch === "default") return node.default ?? [];
  return node.cases.find((c) => c.id === nodeRun.branch)?.nodes ?? [];
};

const INPUT_TYPES: Record<InputDeclarations[string]["type"], z.ZodType<JsonValue>> = {
  string: z.string(),
  number: z.number(),
  boolean: z.boolean(),
  object: z.record(z.string(), z.json()),
  array: z.array(z.json()),
};

// The workflow's inputs with their defaults filled in; an input that breaks its declaration throws.
const resolveWorkflowInputs = (
  declarations: InputDeclarations,
  given: Readonly<Record<string, JsonValue>>,
): Record<string, JsonValue> => {
  const fields = Object.entries(declarations).map(([name, declaration]) => {
    const base = INPUT_TYPES[declaration.type];
    if (declaration.default !== undefined) return [name, base.prefault(declaration.default)];
    return [name, declaration.required ? base : base.optional()];
  });
  const parsed = z.strictObject(Object.fromEntries(fields)).safeParse(given);
  if (parsed.success) return parsed.data as Record<string, JsonValue>;
  const [issue] = parsed.error.issues;
  const where =
    issue === undefined || issue.path.length === 0 ? "inputs" : `inputs.${issue.path.join(".")}`;
  throw new WorkflowError("input", `${where}: ${issue?.message ?? "invalid inputs"}`);
};

// An include's input with the included workflow's defaults filled in, or why it does not fit.
const resolveIncludeInputs = (
  node: PlanIncludeNode,
  input: JsonValue,
): Record<string, JsonValue> | NodeFailure => {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return new NodeFailure("validation", `${node.id}: include input must be an object`);
  }
  try {
    return resolveWorkflowInputs(node.plan.inputs, input);
  } catch (error) {
    if (!(error instanceof WorkflowError)) throw error;
    return new NodeFailure("validation", error.message, undefined, { cause: error });
  }
};

// The case a switch takes: the one whose value matches, by type too, else "default" when it has
// one; the skip when none fits, or why the expression cannot be worked out.
const pickBranch = (node: PlanSwitchNode, scope: Scope): string | SkipOutput | NodeFailure => {
  try {
    const value = evaluateScalar(node.expression, scope);
    const matched = node.cases.find((c) => c.value === value)?.id;
    if (matched !== undefined) return matched;
    if (node.default !== undefined) return "default";
    return { reason: "no-matching-case", proof: { expression: node.expression, value } };
  } catch (error) {
    if (!(error instanceof NodeFailure)) throw error;
    return error;
  }
};

// A container's output is the output of the last node it ran (the case a switch took, a loop's
// body, the included workflow), null when that node did not complete.
const buildContainerOutput = (
  node: Container,
  nodeRun: NodeRun,
  results: Readonly<Record<string, NodeResult>>,
): JsonValue => {
  const last = pickChildren(node, nodeRun).at(-1);
  const result = last === undefined ? undefined : own(results, last.id);
  return result?.status === "completed" ? (result.output ?? null) : null;
};

const NeedsInputSchema = z.object({ kind: z.literal("needs-input") });

// A failure that needs a person's answer stops its scope even under allowFailure; an `always`
// node's never does, so a retro that fails leaves the run's status alone.
const blocksScope = (node: PlanNode, nodeRun: NodeRun | undefined): boolean => {
  if (nodeRun?.status !== "failed") return false;
  if (!node.allowFailure) return true;
  return !node.always && NeedsInputSchema.safeParse(nodeRun.output).success;
};

// The first of `nodes` whose failure stops its scope.
const findBlockingFailure = (
  nodes: readonly PlanNode[],
  nodeRuns: Readonly<Record<string, NodeRun>>,
): string | undefined => nodes.find((node) => blocksScope(node, own(nodeRuns, node.id)))?.id;

// The artifacts a stage needs, did not mark optional, and no completed node has listed yet.
const findMissingArtifacts = (stage: PlanStage, state: State): readonly string[] => {
  const written = new Set(findConsumedArtifacts(stage, state.nodeRuns).map((ref) => ref.type));
  return stage.consumes
    .filter((consumed) => !consumed.optional && !written.has(consumed.artifact))
    .map((consumed) => consumed.artifact);
};

// An unstarted node either ends before it starts (skipped with why, or failed) or starts.
type Ending = SkipOutput | NodeFailure;
type Start =
  | Readonly<{ kind: "end"; ending: Ending }>
  | Readonly<{
      kind: "start";
      input: JsonValue;
      variables: Readonly<Record<string, string>>;
      scope: Scope;
    }>;

// A stage's variables: its skill's defaults under the node's own values, worked out like its
// input. A variable is text, so a value that works out to anything else fails the node.
const resolveVariables = (node: PlanNode, scope: Scope): Record<string, string> => {
  if (node.type !== "agent" || node.stage === undefined) return {};
  const defaults = Object.entries(node.stage.variables).flatMap(([name, variable]) =>
    variable.default === undefined ? [] : [[name, variable.default]],
  );
  const set = Object.entries(node.variables ?? {}).map(([name, text]) => {
    const value = resolveValue(text, scope);
    if (typeof value === "string") return [name, value];
    const got = JSON.stringify(value);
    throw new NodeFailure(
      "resolution",
      `${node.id}: variable ${name} must be a string, got ${got}`,
    );
  });
  return Object.fromEntries([...defaults, ...set]);
};

const ENDED: ReadonlySet<NodeRun["status"]> = new Set([
  "completed",
  "failed",
  "skipped",
  "cancelled",
]);

// A node that will not run again: it ended, or a failure in its scope keeps it from starting.
const isSettled = (
  node: PlanNode,
  nodes: readonly PlanNode[],
  nodeRuns: Readonly<Record<string, NodeRun>>,
): boolean => {
  const status = own(nodeRuns, node.id)?.status;
  if (status !== undefined && ENDED.has(status)) return true;
  if (status === "running") return false;
  return !node.always && findBlockingFailure(nodes, nodeRuns) !== undefined;
};

// Every node a node waits for, its dependsOn and the node before it, is settled.
const isReady = (
  node: PlanNode,
  nodes: readonly PlanNode[],
  nodeRuns: Readonly<Record<string, NodeRun>>,
): boolean =>
  [...node.dependsOn, ...node.after].every((id) => {
    const waitedOn = nodes.find((sibling) => sibling.id === id);
    return waitedOn === undefined || isSettled(waitedOn, nodes, nodeRuns);
  });

// Every node in the scope is settled, so the container around it can end.
const isScopeOver = (
  nodes: readonly PlanNode[],
  nodeRuns: Readonly<Record<string, NodeRun>>,
): boolean => nodes.every((node) => isSettled(node, nodes, nodeRuns));

// Whether an unstarted node runs: skipped when a dependency was skipped (unless it is `always`)
// or its `when` is false, failed when its input or variables cannot be worked out. The walk starts
// it only once isReady holds, so its dependencies have ended or will never start.
const decideStart = (node: PlanNode, walk: Walk, state: State): Start => {
  const results = findNodeRuns(state.nodeRuns, node.parents);
  const skipped = node.dependsOn.filter((id) => own(results, id)?.status === "skipped");
  if (skipped.length > 0 && !node.always) {
    const ending: Ending = { reason: "dependency-skipped", proof: { dependencies: skipped } };
    return { kind: "end", ending };
  }
  const scope: Scope = {
    inputs: walk.inputs,
    nodes: results,
    ...(walk.loop === undefined ? {} : { iteration: { ...walk.loop, nodes: {} } }),
  };
  try {
    if (node.type !== "switch" && node.when !== undefined && !evaluateBoolean(node.when, scope)) {
      const ending: Ending = {
        reason: "when-false",
        proof: { expression: node.when, value: false },
      };
      return { kind: "end", ending };
    }
    const input = resolveValue(node.input, scope);
    return { kind: "start", input, variables: resolveVariables(node, scope), scope };
  } catch (error) {
    if (error instanceof NodeFailure) return { kind: "end", ending: error };
    throw error;
  }
};

const toEventError = (failure: NodeFailure) =>
  eventError(failure.kind, failure.message, stackOf(failure));

const emitNodeEvent = (
  walk: Walk,
  state: State,
  node: PlanNode,
  event: Readonly<{
    type: string;
    nodeRunId: string;
    payload: Readonly<Record<string, JsonValue>>;
  }>,
): Promise<State> =>
  walk.emit(state, {
    type: `workflow.node.${event.type}`,
    source: "workflow",
    nodeId: node.id,
    nodeRunId: event.nodeRunId,
    payload: { nodeType: node.type, ...buildParentsField(node.parents), ...event.payload },
  });

// Records a node that ends before it starts: skipped with why, or failed with the error that
// stopped it.
const recordSkipOrFail = async (
  node: PlanNode,
  ending: Ending,
  walk: Walk,
  state: State,
): Promise<Walked> => {
  const nodeRunId = createNodeRunId();
  const event =
    ending instanceof NodeFailure
      ? { type: "failed", nodeRunId, payload: { attempts: 0, error: toEventError(ending) } }
      : { type: "skipped", nodeRunId, payload: { attempts: 0, skip: ending } };
  return { state: await emitNodeEvent(walk, state, node, event), step: CONTINUE, started: [] };
};

// Records that a node started, and gives back the state with its new node run.
// An agent node posts to the run's thread, and an exec node does when it has a summary to post.
const postsToThread = (node: PlanNode): boolean => {
  if (node.type === "agent") return node.notify;
  if (node.type === "exec") return node.notify && node.summary !== undefined;
  return false;
};

const recordStart = async (
  node: PlanNode,
  payload: Readonly<Record<string, JsonValue>>,
  walk: Walk,
  state: State,
): Promise<Readonly<{ state: State; nodeRun: NodeRun }>> => {
  const nodeRunId = createNodeRunId();
  const started = await emitNodeEvent(walk, state, node, { type: "started", nodeRunId, payload });
  const nodeRun = findNodeRun(started, node);
  if (nodeRun === undefined) throw new Error(`${node.id}: no node run after it started`);
  return { state: started, nodeRun };
};

// Ends a container: failed with `failure` or, without one, with its first child whose failure
// stops its scope, as needs-input when that child's was; otherwise completed with its output.
const endContainer = async (
  node: Container,
  nodeRun: NodeRun,
  walk: Walk,
  state: State,
  ending: Readonly<{ attempts: number; failure?: NodeFailure }> = { attempts: 1 },
): Promise<Walked> => {
  const results = findNodeRuns(state.nodeRuns, [...node.parents, node.id]);
  const failedChild = findBlockingFailure(pickChildren(node, nodeRun), results);
  const childOutput = failedChild === undefined ? undefined : own(results, failedChild)?.output;
  const childKind = NeedsInputSchema.safeParse(childOutput).success ? "needs-input" : "exception";
  const failure =
    ending.failure ??
    (failedChild === undefined
      ? undefined
      : new NodeFailure(childKind, `${node.id}.${failedChild} failed`));
  const payload =
    failure === undefined
      ? { attempts: ending.attempts, output: buildContainerOutput(node, nodeRun, results) }
      : { attempts: ending.attempts, error: toEventError(failure) };
  const type = failure === undefined ? "completed" : "failed";
  const event = { type, nodeRunId: nodeRun.nodeRunId, payload };
  return { state: await emitNodeEvent(walk, state, node, event), step: CONTINUE, started: [] };
};

// A draining container waits while any of its children runs, then ends failed.
const drainContainer = async (
  node: Container,
  nodeRun: NodeRun,
  walk: Walk,
  walked: Walked,
): Promise<Walked> => {
  const results = findNodeRuns(walked.state.nodeRuns, [...node.parents, node.id]);
  const open = pickChildren(node, nodeRun).some(
    (child) => own(results, child.id)?.status === "running",
  );
  if (open) return walked;
  const failure = new NodeFailure("exception", `${node.id} stopped: a node in its scope failed`);
  return endContainer(node, nodeRun, walk, walked.state, { attempts: 1, failure });
};

const isSameModel = (target: TierModel, current: TierModel | null): boolean =>
  current !== null &&
  target.model === current.model &&
  (target.effort === undefined || target.effort === current.effort);

// The tier an agent node runs on, first one set: its own, its stage's, the run's default. setBy
// names where it came from, for an error about it.
export const pickNodeTier = (
  node: PlanAgentNode,
  runDefault: string,
): Readonly<{ tier: string; setBy: string }> => {
  if (node.tier !== undefined) return { tier: node.tier, setBy: node.id };
  if (node.stage?.tier !== undefined) return { tier: node.stage.tier, setBy: node.stage.ref };
  return { tier: runDefault, setBy: "the run's default" };
};

// The node's own mode, else its stage's, else inline; an agent that cannot start subagents runs
// every node inline.
const pickNodeMode = (node: PlanAgentNode, subagents: boolean): AgentMode => {
  const mode = node.mode ?? node.stage?.mode ?? "inline";
  return subagents ? mode : "inline";
};

const pickRunsOn = (node: PlanAgentNode, walk: Walk): RunsOn => {
  const mode = pickNodeMode(node, walk.subagents);
  if (mode === "inline" || walk.tiers === null) return { mode, tier: null };
  return { mode, tier: pickNodeTier(node, walk.tiers.default).tier };
};

// Who runs an agent step and on what. A run that cannot switch models runs every step on its
// launch model, the default tier's; by the time a switching run starts a step, executeLeaf
// has put its session on the step's tier. A subagent step runs on its subagentModel.
const pickAgentFields = (
  node: PlanAgentNode,
  walk: Walk,
  state: State,
  subagentModel: TierModel | null,
) => {
  const sessionId = state.activeSessions.find((s) => s.agent === walk.agent)?.sessionId ?? null;
  const stage = node.stage === undefined ? {} : { stage: node.stage.name };
  if (walk.tiers === null) {
    const launched =
      state.tiers === null ? undefined : own(state.tiers.models, state.tiers.default);
    const tier = state.tiers?.default ?? null;
    const model = launched?.model ?? null;
    return { ...stage, agentState: { agent: walk.agent, tier, model, sessionId, tokens: null } };
  }
  const { tier } = pickNodeTier(node, walk.tiers.default);
  const model = subagentModel?.model ?? walk.switching.current?.model ?? null;
  return { ...stage, agentState: { agent: walk.agent, tier, model, sessionId, tokens: null } };
};

// The model an agent node's tier names; undefined when the run never switches models, or a
// failure when the run has no such tier.
const findTierModel = (node: Leaf, walk: Walk): TierModel | NodeFailure | undefined => {
  if (walk.tiers === null || node.type !== "agent") return undefined;
  const { tier } = pickNodeTier(node, walk.tiers.default);
  const target = own(walk.tiers.models, tier);
  if (target !== undefined) return target;
  const names = Object.keys(walk.tiers.models).join(", ");
  const message = `${node.id}: tier "${tier}" is not one of the run's tiers: ${names}`;
  return new NodeFailure("validation", message);
};

const requestModel = async (
  node: Leaf,
  target: TierModel,
  walk: Walk,
  state: State,
): Promise<Walked> => {
  const path = nodePath(node.parents, node.id);
  const { pending, failed } = walk.switching;
  const step: Step = { kind: "model", nodeId: node.id, ...target };
  if (pending?.node === path) return { state, step, started: [] };
  if (failed?.node === path) {
    const message = `${node.id}: switching to ${target.model} failed: ${failed.reason}`;
    const recorded = await recordSkipOrFail(
      node,
      new NodeFailure("exception", message),
      walk,
      state,
    );
    return { state: recorded.state, step: { kind: "rewalk" }, started: [] };
  }
  const requested = await walk.emit(state, {
    type: "workflow.model.requested",
    source: "workflow",
    payload: { node: path, ...tierLaunch(target) },
  });
  return { state: requested, step, started: [] };
};

const isInlineOpen = (walk: Walk, state: State): boolean =>
  findRunningLeaves(walk.root, state.nodeRuns).some(
    ({ node }) => node.type === "agent" && pickNodeMode(node, walk.subagents) === "inline",
  );

// The node stays unstarted, for a later `next` to hand out.
const leaveUnstarted = (state: State): Walked => ({ state, step: CONTINUE, started: [] });

// A leaf node (exec, wait, agent or context): started once it can start, unless the work already
// open must end first. A context node goes out alone; every other leaf joins the walk's list.
const executeLeaf = async (
  node: Leaf,
  nodeRun: NodeRun | undefined,
  walk: Walk,
  state: State,
): Promise<Walked> => {
  if (nodeRun?.status === "running") return leaveUnstarted(state);
  const start = decideStart(node, walk, state);
  if (start.kind === "end") return recordSkipOrFail(node, start.ending, walk, state);
  if (node.type === "agent" && node.stage !== undefined) {
    const missing = findMissingArtifacts(node.stage, state);
    if (missing.length > 0) {
      const blocked = { nodeId: node.id, stage: node.stage.ref, missing };
      // One id per node, so the nexts that find it still blocked store the event once.
      const recorded = await walk.emit(state, {
        id: `workflow-blocked:${node.id}`,
        type: "workflow.blocked",
        source: "workflow",
        nodeId: node.id,
        payload: { ...blocked, missing: [...missing] },
      });
      return { state: recorded, step: { kind: "blocked", ...blocked }, started: [] };
    }
  }
  const target = findTierModel(node, walk);
  if (target instanceof NodeFailure) return recordSkipOrFail(node, target, walk, state);
  const runsOn = node.type === "agent" ? pickRunsOn(node, walk) : null;
  // a subagent runs on its tier's model, so the session stays on the one it has
  const inSession = runsOn?.mode !== "subagent";
  const switches =
    inSession && target !== undefined && !isSameModel(target, walk.switching.current);
  const busy = findRunningLeaves(walk.root, state.nodeRuns).length > 0;
  // a context step or a model switch restarts the session, which would kill the open work
  if ((node.type === "context" || switches) && busy) return leaveUnstarted(state);
  if (switches && target !== undefined) return requestModel(node, target, walk, state);
  if (runsOn?.mode === "inline" && isInlineOpen(walk, state)) return leaveUnstarted(state);
  if (!walk.parallel && busy) return leaveUnstarted(state);
  const { input, variables } = start;
  const subagentModel = inSession ? null : (target ?? null);
  const agentFields =
    node.type === "agent" ? pickAgentFields(node, walk, state, subagentModel) : {};
  const notify = postsToThread(node);
  const mode = runsOn === null ? {} : { mode: runsOn.mode };
  const started = await recordStart(node, { input, notify, ...agentFields, ...mode }, walk, state);
  const { nodeRunId } = started.nodeRun;
  if (node.type === "context") {
    return { state: started.state, step: { kind: "context", node, nodeRunId }, started: [] };
  }
  const leaf: StartedLeaf = { node, nodeRunId, input, variables, runsOn };
  return { state: started.state, step: CONTINUE, started: [leaf] };
};

// A switch: starts on the case whose value matches (or its default), walks that case's nodes,
// then ends. No matching case skips it.
const executeSwitch = async (
  node: PlanSwitchNode,
  nodeRun: NodeRun | undefined,
  walk: Walk,
  state: State,
): Promise<Walked> => {
  if (nodeRun === undefined) {
    const start = decideStart(node, walk, state);
    if (start.kind === "end") return recordSkipOrFail(node, start.ending, walk, state);
    const branch = pickBranch(node, start.scope);
    if (typeof branch !== "string") return recordSkipOrFail(node, branch, walk, state);
    const started = await recordStart(node, { input: start.input, branch }, walk, state);
    return executeSwitch(node, started.nodeRun, walk, started.state);
  }
  const inside: Walk = { ...walk, inputs: nodeRun.input ?? null, loop: undefined };
  const children = pickChildren(node, nodeRun);
  const walked = await executeNodes(children, inside, state);
  if (walked.step.kind !== "continue") return walked;
  if (walk.draining) return drainContainer(node, nodeRun, walk, walked);
  const results = findNodeRuns(walked.state.nodeRuns, [...node.parents, node.id]);
  if (!isScopeOver(children, results)) return walked;
  return endContainer(node, nodeRun, walk, walked.state);
};

// An include: starts once its input fits the included workflow's inputs, walks that workflow's
// nodes, then ends.
const executeInclude = async (
  node: PlanIncludeNode,
  nodeRun: NodeRun | undefined,
  walk: Walk,
  state: State,
): Promise<Walked> => {
  if (nodeRun === undefined) {
    const start = decideStart(node, walk, state);
    if (start.kind === "end") return recordSkipOrFail(node, start.ending, walk, state);
    // Recorded with its defaults filled in, so the included nodes read it as their inputs.
    const input = resolveIncludeInputs(node, start.input);
    if (input instanceof NodeFailure) return recordSkipOrFail(node, input, walk, state);
    const started = await recordStart(node, { input }, walk, state);
    return executeInclude(node, started.nodeRun, walk, started.state);
  }
  const inside: Walk = { ...walk, inputs: nodeRun.input ?? null, loop: undefined };
  const walked = await executeNodes(node.plan.nodes, inside, state);
  if (walked.step.kind !== "continue") return walked;
  if (walk.draining) return drainContainer(node, nodeRun, walk, walked);
  const results = findNodeRuns(walked.state.nodeRuns, [...node.parents, node.id]);
  if (!isScopeOver(node.plan.nodes, results)) return walked;
  return endContainer(node, nodeRun, walk, walked.state);
};

// A loop's node run holds only its current pass: `iteration` numbers it, and `output` is the output
// of the pass before it (its last body node's), which the pass reads as `iteration.previous`; `iteration.max` is its
// maxIterations. Once a pass ends, until
// decides: stop, fail, or record the next pass (which clears the children) and walk it.
const executeLoop = async (
  node: PlanLoopNode,
  nodeRun: NodeRun | undefined,
  walk: Walk,
  state: State,
): Promise<Walked> => {
  if (nodeRun === undefined) {
    const start = decideStart(node, walk, state);
    if (start.kind === "end") return recordSkipOrFail(node, start.ending, walk, state);
    const started = await recordStart(node, { input: start.input }, walk, state);
    return executeLoop(node, started.nodeRun, walk, started.state);
  }
  const index = nodeRun.iteration ?? 1;
  const previous = nodeRun.output ?? null;
  const max = node.maxIterations;
  const inside: Walk = { ...walk, inputs: nodeRun.input ?? null, loop: { index, max, previous } };
  const walked = await executeNodes(node.nodes, inside, state);
  if (walked.step.kind !== "continue") return walked;
  if (walk.draining) return drainContainer(node, nodeRun, walk, walked);
  const results = findNodeRuns(walked.state.nodeRuns, [...node.parents, node.id]);
  if (!isScopeOver(node.nodes, results)) return walked;
  const ending = { attempts: index };
  if (findBlockingFailure(node.nodes, results) !== undefined) {
    return endContainer(node, nodeRun, walk, walked.state, ending);
  }
  try {
    const iteration = { index, max, previous, nodes: results };
    if (evaluateBoolean(node.until, { inputs: inside.inputs, nodes: {}, iteration })) {
      return endContainer(node, nodeRun, walk, walked.state, ending);
    }
  } catch (error) {
    if (!(error instanceof NodeFailure)) throw error;
    return endContainer(node, nodeRun, walk, walked.state, { ...ending, failure: error });
  }
  if (index >= max) {
    const message = `${node.id} ran ${node.maxIterations} times and until never held`;
    const failure = new NodeFailure("exhausted", message);
    return endContainer(node, nodeRun, walk, walked.state, { ...ending, failure });
  }
  const output = buildContainerOutput(node, nodeRun, results);
  const event = {
    type: "iterated",
    nodeRunId: nodeRun.nodeRunId,
    payload: { iteration: index + 1, output },
  };
  const next = await emitNodeEvent(walk, walked.state, node, event);
  return executeLoop(node, findNodeRun(next, node), walk, next);
};

const executeNode = (
  node: PlanNode,
  nodeRun: NodeRun | undefined,
  walk: Walk,
  state: State,
): Promise<Walked> => {
  switch (node.type) {
    case "switch":
      return executeSwitch(node, nodeRun, walk, state);
    case "include":
      return executeInclude(node, nodeRun, walk, state);
    case "loop":
      return executeLoop(node, nodeRun, walk, state);
    default:
      return executeLeaf(node, nodeRun, walk, state);
  }
};

// Walks every node in the scope, starting each one that is ready, until one needs a reply of its
// own. Once a node in this scope has failed without allowFailure only `always` nodes still start
// and a running container drains; the container around them sees the failure and ends failed.
async function executeNodes(nodes: readonly PlanNode[], walk: Walk, state: State): Promise<Walked> {
  let current = state;
  let started: readonly StartedLeaf[] = [];
  for (const node of nodes) {
    const siblings = findNodeRuns(current.nodeRuns, node.parents);
    const draining =
      walk.draining || (!node.always && findBlockingFailure(nodes, siblings) !== undefined);
    const found = findNodeRun(current, node);
    // an interrupted node starts again as if it never ran; the old run stays in event.jsonl
    const nodeRun = found?.status === "interrupted" ? undefined : found;
    if (nodeRun !== undefined && nodeRun.status !== "running") continue;
    if (nodeRun === undefined && (draining || !isReady(node, nodes, siblings))) continue;
    const inner: Walk = { ...walk, draining };
    let walked: Walked;
    try {
      walked = await executeNode(node, nodeRun, inner, current);
    } catch (error) {
      // leaves this walk already started would stay running with no handout, so the walk ends here
      if (started.length === 0) throw error;
      return { state: current, step: { kind: "halted", error }, started };
    }
    started = [...started, ...walked.started];
    if (walked.step.kind !== "continue") return { ...walked, started };
    current = walked.state;
  }
  return { state: current, step: CONTINUE, started };
}

// Ends each leaf as interrupted, as `resume` would, one event after another.
const interruptLeaves = async (
  leaves: readonly StartedLeaf[],
  emit: Emit,
  state: State,
): Promise<void> => {
  let current = state;
  for (const { node, nodeRunId } of leaves) {
    const payload = { nodeType: node.type, ...buildParentsField(node.parents), attempts: 1 };
    const event = { type: "workflow.node.interrupted", source: "workflow", nodeId: node.id };
    current = await emit(current, { ...event, nodeRunId, payload });
  }
};

// One `next`: walks the workflow from the top, recording the engine's own events as it goes, and
// replies with every leaf it started, or what it waits on, or the run's end. startedBefore holds
// what an earlier walk of the same `next` started before a rewalk.
export const decideNext = async (
  plan: WorkflowPlan,
  state: State,
  emit: Emit,
  models: ModelInputs = NO_MODELS,
  startedBefore: readonly StartedLeaf[] = [],
): Promise<Readonly<{ state: State; decision: Decision }>> => {
  if (!isRunLive(state.status)) {
    return { state, decision: { kind: "finished", status: state.status } };
  }
  const inputs = resolveWorkflowInputs(plan.inputs, state.input);
  const open = new Set(
    findRunningLeaves(plan.nodes, state.nodeRuns).map(({ nodeRun }) => nodeRun.nodeRunId),
  );
  const walked = await executeNodes(
    plan.nodes,
    {
      emit,
      agent: plan.agent,
      inputs,
      loop: undefined,
      root: plan.nodes,
      draining: false,
      ...models,
    },
    state,
  );
  const started = [...startedBefore, ...walked.started];
  if (walked.step.kind === "halted") {
    // the handout is lost with the error, so the leaves it would have carried end as interrupted
    await interruptLeaves(started, emit, walked.state);
    throw walked.step.error;
  }
  if (walked.step.kind === "rewalk") {
    // the failed switch is spent: its stage has failed, so a later loop pass asks again
    const switching = { ...models.switching, failed: null };
    return decideNext(plan, walked.state, emit, { ...models, switching }, started);
  }
  // leaves started before a blocked stage still go out; the next `next` reports the block again
  const handsOut = walked.step.kind === "blocked" && started.length > 0;
  if (walked.step.kind !== "continue" && !handsOut) {
    return { state: walked.state, decision: walked.step };
  }
  const running = findRunningLeaves(plan.nodes, walked.state.nodeRuns);
  if (started.length > 0) {
    const othersRunning = running.some(({ nodeRun }) => open.has(nodeRun.nodeRunId));
    return { state: walked.state, decision: { kind: "steps", steps: started, othersRunning } };
  }
  if (running.length > 0) {
    const ids = running.map(({ node, nodeRun }) => ({
      nodeRunId: nodeRun.nodeRunId,
      nodeId: node.id,
    }));
    return { state: walked.state, decision: { kind: "waiting", running: ids } };
  }
  const status =
    findBlockingFailure(plan.nodes, walked.state.nodeRuns) === undefined ? "completed" : "failed";
  const event = { type: `workflow.${status}`, source: "workflow", payload: {} };
  return { state: await emit(walked.state, event), decision: { kind: "finished", status } };
};

// A running leaf and its node run in state.json.
export type RunningLeaf = Readonly<{ node: Leaf; nodeRun: NodeRun }>;

// Every running leaf, those inside running containers included.
export const findRunningLeaves = (
  nodes: readonly PlanNode[],
  nodeRuns: Readonly<Record<string, NodeRun>>,
): readonly RunningLeaf[] =>
  nodes.flatMap((node): readonly RunningLeaf[] => {
    const nodeRun = own(nodeRuns, node.id);
    if (nodeRun?.status !== "running") return [];
    if (isLeaf(node)) return [{ node, nodeRun }];
    return findRunningLeaves(pickChildren(node, nodeRun), nodeRun.nodes ?? {});
  });

// The running leaf whose run is `nodeRunId`, for exec and done.
export const findRunningLeaf = (
  nodes: readonly PlanNode[],
  nodeRuns: Readonly<Record<string, NodeRun>>,
  nodeRunId: string,
): RunningLeaf | undefined =>
  findRunningLeaves(nodes, nodeRuns).find((leaf) => leaf.nodeRun.nodeRunId === nodeRunId);
