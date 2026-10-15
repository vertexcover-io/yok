import {
  type EmitInput,
  type Event,
  type HookDeps,
  type HookReply,
  type NodeRun,
  type RunRef,
  readPolicies,
  readState,
  runDirOf,
  type State,
  type StopHandler,
  type StopInput,
  type StopReason,
  type TranscriptEntry,
} from "@yok/sdk";
import {
  appendRunEvent,
  foldModelSwitch,
  isRunLive,
  jsonlEventStore,
  type ModelSwitch,
} from "@yok/sdk/internal";
import { startContextStep, startModelStep } from "../context-step.ts";
import { completeContextStep, findContextPlanNode, finishStep, orchestrateLine } from "../runs.ts";
import { findSessionRun, noAnswerMessage, recordRunEvent } from "./common.ts";

export const DEFAULT_STOP_MAX_BLOCKS = 1;
// `yok orchestrate next` or `bun …/index.ts orchestrate done`, but not a path like orchestrate/SKILL.md
const ORCHESTRATE =
  /\borchestrate(?:\.ts)?\s+(?:init|link-session|emit|next|resume|exec|done|await-approval)\b/;
const ASK_RULE =
  "If you need the user's input, ask the way the orchestrate skill's reference for your agent says.";

const ALLOW: HookReply = { kind: "allow" };

type ActiveLeaf = Readonly<{
  nodeId: string;
  nodeRunId: string;
  nodeType: NodeRun["nodeType"];
  awaitingApproval: string | undefined;
}>;

export type StopCheck = Readonly<{
  run: RunRef;
  state: State;
  // the run's interaction policy; off, no stop with an agent node open goes through
  interaction?: boolean;
  touchedRun: boolean | undefined;
  // whether anything but a hook's own log happened since the last Stop check
  progressSinceCheck: boolean;
  maxBlocks: number;
  waitingOnBackground: boolean;
  // the model switch next asked for that no helper has answered yet
  pendingSwitch: ModelSwitch["pending"];
}>;

// `blockStreak` is the blocks in a row at this spot, counting this call when it blocks. A decision
// with a message sends the agent back to work; one without lets the turn end.
export type StopDecision =
  | Readonly<{
      reason: Extract<
        StopReason,
        "run-finished" | "user-chat" | "max-blocks-reached" | "background-task"
      >;
      blockStreak: number;
    }>
  | Readonly<{ reason: "context-node"; blockStreak: number; nodeRunId: string }>
  | Readonly<{ reason: "model-switch"; blockStreak: number; seq: number }>
  | Readonly<{ reason: "awaiting-approval"; blockStreak: number; nodeRunId: string }>
  | Readonly<{ reason: "next-not-run"; blockStreak: number; message: string }>
  | Readonly<{ reason: "node-not-done"; blockStreak: number; message: string; nodeRunId: string }>
  | Readonly<{
      reason: "unanswered-stop";
      blockStreak: number;
      message: string;
      nodeRunId: string;
    }>;

type Position =
  | Readonly<{ kind: "finished" }>
  | Readonly<{ kind: "open-node"; leaf: ActiveLeaf }>
  | Readonly<{ kind: "between-nodes" }>;

// A loop, switch or include stays running while it waits between children, so the node being
// worked on is the running entry of any other type.
const CONTAINERS: ReadonlySet<NodeRun["nodeType"]> = new Set(["loop", "switch", "include"]);

const findActiveLeaf = (nodeRuns: Readonly<Record<string, NodeRun>>): ActiveLeaf | undefined => {
  for (const [nodeId, run] of Object.entries(nodeRuns)) {
    if (run.status !== "running") continue;
    if (!CONTAINERS.has(run.nodeType)) {
      return {
        nodeId,
        nodeRunId: run.nodeRunId,
        nodeType: run.nodeType,
        awaitingApproval: run.awaitingApproval,
      };
    }
    if (run.nodes === undefined) continue;
    const child = findActiveLeaf(run.nodes);
    if (child !== undefined) return child;
  }
  return undefined;
};

const touchedRunSinceLastPrompt = (
  entries: readonly TranscriptEntry[] | undefined,
): boolean | undefined => {
  if (entries === undefined) return undefined;
  const last = entries.findLastIndex((entry) => entry.kind === "prompt");
  if (last === -1) return undefined;
  return entries
    .slice(last + 1)
    .some((entry) => entry.kind === "command" && ORCHESTRATE.test(entry.command));
};

const maxBlocksOf = (env: HookDeps["env"]): number => {
  const maxBlocks = Number(env.YOK_STOP_MAX_BLOCKS);
  return Number.isInteger(maxBlocks) && maxBlocks > 0 ? maxBlocks : DEFAULT_STOP_MAX_BLOCKS;
};

const priorBlocks = (state: State, progressSinceCheck: boolean): number =>
  state.stopHook === undefined || progressSinceCheck ? 0 : state.stopHook.blockStreak;

// Progress is any event after the last check except the hooks' own logs, which only observe the
// run, and agent.stuck, which this hook records as it gives up.
const progressSince = (events: readonly Event[], seq: number | undefined): boolean =>
  seq !== undefined &&
  events.some(
    (event) => event.seq > seq && !event.type.startsWith("hooks.") && event.type !== "agent.stuck",
  );

const nextMessage = (run: RunRef): string =>
  `Yok run ${run.name} is not finished. Run \`${orchestrateLine({ verb: "next", run })}\` ` +
  `and do the step it prints, as the orchestrate skill says. ${ASK_RULE}`;

// next hands out an exec or wait node for the agent to run with exec, and an agent node for it to
// do and then record with done; done refuses an exec node, so each gets its own command.
const openNodeMessage = (run: RunRef, leaf: ActiveLeaf): string => {
  const { nodeId, nodeRunId } = leaf;
  if (leaf.nodeType === "agent") {
    const done = orchestrateLine({ verb: "done", run, nodeRunId });
    return (
      `Yok run ${run.name}: node ${nodeId} is still open. Finish the node's work and record ` +
      `it with \`${done} --output -\` (or \`--error -\`). ${ASK_RULE}`
    );
  }
  const exec = orchestrateLine({ verb: "exec", run, nodeRunId });
  return (
    `Yok run ${run.name}: step ${nodeId} is still open. If you have not run it yet, run ` +
    `\`${exec}\`. If it is already running as a background task, wait for that task to finish. ` +
    ASK_RULE
  );
};

const unansweredStopMessage = (run: RunRef, leaf: ActiveLeaf): string => {
  const done = orchestrateLine({ verb: "done", run, nodeRunId: leaf.nodeRunId });
  return (
    `Yok run ${run.name}: node ${leaf.nodeId} is still open. ${noAnswerMessage(done)} ` +
    `Otherwise finish it with \`${done} --output -\`.`
  );
};

const positionOf = (state: State): Position => {
  if (!isRunLive(state.status)) return { kind: "finished" };
  const leaf = findActiveLeaf(state.nodeRuns);
  return leaf === undefined ? { kind: "between-nodes" } : { kind: "open-node", leaf };
};

export const decideStop = ({
  run,
  state,
  interaction = true,
  touchedRun,
  progressSinceCheck,
  maxBlocks,
  waitingOnBackground,
  pendingSwitch,
}: StopCheck): StopDecision => {
  const prior = priorBlocks(state, progressSinceCheck);
  const position = positionOf(state);
  if (position.kind === "finished") return { reason: "run-finished", blockStreak: prior };
  // A context node's work starts once the turn is over, so the stop is the cue, not a lapse.
  if (position.kind === "open-node" && position.leaf.nodeType === "context") {
    return { reason: "context-node", blockStreak: prior, nodeRunId: position.leaf.nodeRunId };
  }
  // The user reviews now; an empty input box is what lets their viewer comments in.
  if (position.kind === "open-node" && position.leaf.awaitingApproval !== undefined) {
    return { reason: "awaiting-approval", blockStreak: prior, nodeRunId: position.leaf.nodeRunId };
  }
  // A model step's switch also starts once the turn is over.
  if (position.kind === "between-nodes" && pendingSwitch !== null) {
    return { reason: "model-switch", blockStreak: prior, seq: pendingSwitch.seq };
  }
  // The task's end wakes the agent, so a turn that waits on it is neither a lapse nor stuck.
  if (waitingOnBackground) return { reason: "background-task", blockStreak: prior };
  if (position.kind === "between-nodes" && touchedRun === false)
    return { reason: "user-chat", blockStreak: prior };
  // No one answers, so the agent is sent back each time, and fails the node once it keeps stopping.
  if (!interaction && position.kind === "open-node" && position.leaf.nodeType === "agent") {
    const { leaf } = position;
    const { nodeRunId } = leaf;
    if (prior >= maxBlocks) {
      return {
        reason: "unanswered-stop",
        blockStreak: prior + 1,
        message: nextMessage(run),
        nodeRunId,
      };
    }
    const message = unansweredStopMessage(run, leaf);
    return { reason: "node-not-done", blockStreak: prior + 1, message, nodeRunId };
  }
  if (prior >= maxBlocks) return { reason: "max-blocks-reached", blockStreak: prior };
  if (position.kind === "between-nodes") {
    return { reason: "next-not-run", blockStreak: prior + 1, message: nextMessage(run) };
  }
  const { leaf } = position;
  return {
    reason: "node-not-done",
    blockStreak: prior + 1,
    message: openNodeMessage(run, leaf),
    nodeRunId: leaf.nodeRunId,
  };
};

const replyOf = (decision: StopDecision): HookReply =>
  "message" in decision ? { kind: "continue", message: decision.message } : ALLOW;

const stopCalledEvent = (
  input: StopInput,
  check: StopCheck,
  decision: StopDecision,
): EmitInput => ({
  type: "hooks.stop.called",
  source: "hooks",
  payload: {
    agent: input.agent,
    sessionId: input.sessionId,
    touchedRun: check.touchedRun ?? null,
    decision: replyOf(decision).kind,
    reason: decision.reason,
    blockStreak: decision.blockStreak,
    ...("message" in decision ? { message: decision.message } : {}),
    ...("nodeRunId" in decision ? { nodeRunId: decision.nodeRunId } : {}),
  },
});

// Only a turn between nodes reads touchedRun, so only then is the transcript worth reading.
const readTouchedRun = async (input: StopInput, state: State): Promise<boolean | undefined> =>
  positionOf(state).kind === "between-nodes"
    ? touchedRunSinceLastPrompt(await input.readTranscript())
    : undefined;

// An agent without context steps: the node ends as not applied and the session goes on to `next`.
const decideForAgent = async (input: StopInput, check: StopCheck): Promise<StopDecision> => {
  const decision = decideStop(check);
  if (decision.reason !== "context-node" || input.contextSteps) return decision;
  const planNode = await findContextPlanNode(check.run, decision.nodeRunId);
  if (!planNode.ok) throw new Error(planNode.error);
  const completed = await completeContextStep(check.run, decision.nodeRunId, {
    action: planNode.value.action,
    applied: false,
    reason: `context steps are not supported on ${input.agent}`,
  });
  if (!completed.ok) throw new Error(completed.error);
  return {
    reason: "next-not-run",
    blockStreak: decision.blockStreak + 1,
    message: nextMessage(check.run),
  };
};

// The agent kept stopping with its node open and no one to answer: the node fails with what it
// last said, which is usually its question. done records it as needs-input, which ends the run.
const failUnansweredNode = async (
  run: RunRef,
  nodeRunId: string,
  lastMessage: string | undefined,
  deps: HookDeps,
): Promise<void> => {
  const said = lastMessage?.trim() || "(the agent's last message was not available)";
  const error = `The agent stopped without finishing, and no one will answer. It last said: ${said}`;
  const failed = await finishStep(run, nodeRunId, { error }, []);
  if (!failed.ok) {
    deps.log.warn({ error: failed.error }, "the unanswered node was not failed");
    return;
  }
  const payload = { policy: "interaction", effect: "unanswered-stop", nodeId: failed.value.nodeId };
  await recordRunEvent(run, { type: "policy.applied", payload }, deps);
};

// Decides whether the agent may end its turn and logs the call as hooks.stop.called. It never
// throws: a hook that fails must let the turn end, or it could trap the session.
export const runStopHook = async (input: StopInput, deps: HookDeps): Promise<HookReply> => {
  try {
    const run = await findSessionRun(input, deps);
    if (run === undefined) {
      deps.log.debug({ sessionId: input.sessionId }, "stop allowed: not a yok run session");
      return ALLOW;
    }
    const runDir = runDirOf(run.cwd, run.name);
    const state = await readState(runDir);
    if (state === null) return ALLOW;
    const [touchedRun, events] = await Promise.all([
      readTouchedRun(input, state),
      jsonlEventStore(runDir).read(),
    ]);
    const check = {
      run,
      state,
      interaction: readPolicies(state.policies).interaction,
      touchedRun,
      progressSinceCheck: progressSince(events, state.stopHook?.seq),
      maxBlocks: maxBlocksOf(deps.env),
      waitingOnBackground: input.waitingOnBackground,
      pendingSwitch: foldModelSwitch(events, state.tiers).pending,
    };
    const decision = await decideForAgent(input, check);
    const stored = await appendRunEvent(run, stopCalledEvent(input, check, decision));
    if (!stored.ok) {
      // An unrecorded block would reset the count, so it could block forever.
      deps.log.warn({ error: stored.error }, "stop allowed: the hook call was not recorded");
      return ALLOW;
    }
    if (decision.reason === "context-node") {
      await startContextStep(run, input.sessionId, decision.nodeRunId);
    }
    if (decision.reason === "model-switch") {
      await startModelStep(run, input.sessionId, decision.seq);
    }
    if (decision.reason === "unanswered-stop") {
      await failUnansweredNode(run, decision.nodeRunId, input.lastMessage, deps);
    }
    if (decision.reason === "max-blocks-reached") {
      const payload = { agent: input.agent, sessionId: input.sessionId };
      await recordRunEvent(run, { type: "agent.stuck", payload }, deps);
    }
    return replyOf(decision);
  } catch (error) {
    deps.log.error({ err: error }, "stop allowed: the stop hook failed");
    return ALLOW;
  }
};

// Keeps a workflow run moving: sends the agent back when it stops with work still owed.
export const continueWorkflow: StopHandler = { name: "continue-workflow", run: runStopHook };

// The handlers an agent can register, by the name `orchestrate hook stop --handler` takes.
export const stopHandlers: Readonly<Record<string, StopHandler>> = Object.fromEntries(
  [continueWorkflow].map((handler) => [handler.name, handler]),
);

// Runs one Stop handler. It never throws: a handler that fails lets the turn end, or it could
// trap the session.
export const runStop = (
  input: StopInput,
  handler: StopHandler,
  deps: HookDeps,
): Promise<HookReply> =>
  handler.run(input, deps).catch((error: unknown): HookReply => {
    deps.log.error({ err: error }, `stop allowed: ${handler.name} failed`);
    return ALLOW;
  });
