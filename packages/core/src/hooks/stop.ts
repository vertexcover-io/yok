import {
  type EmitInput,
  type Event,
  type HookDeps,
  type HookReply,
  type NodeRun,
  PreToolUseCalledEvent,
  type RunRef,
  readPolicies,
  readState,
  runDirOf,
  SessionStartCalledEvent,
  type State,
  StopCalledEvent,
  type StopHandler,
  type StopInput,
  type StopReason,
  type TranscriptEntry,
} from "@yok/sdk";
import {
  appendRunEvent,
  findRunningLeaf,
  foldModelSwitch,
  isRunLive,
  jsonlEventStore,
  type ModelSwitch,
} from "@yok/sdk/internal";
import * as z from "zod";
import { startCloseStep, startContextStep, startModelStep } from "../context-step.ts";
import { completeContextStep, findContextPlanNode, finishStep, orchestrateLine } from "../runs.ts";
import { findSessionRun, noAnswerMessage, recordRunEvent } from "./common.ts";

const RUN_ENDED: ReadonlySet<string> = new Set(["workflow.completed", "workflow.failed"]);

const startedSession = (event: Event): string | undefined =>
  event.type === "hooks.session-start.called"
    ? SessionStartCalledEvent.safeParse(event).data?.payload.sessionId
    : undefined;

// The seq of the run's finish event when this session finished the run: it started before the
// finish, or before init and so logged no start. A session resumed after the finish logs its start
// later and gets undefined. Compared by seq, since two events can share a timestamp.
export const finishedBySession = (
  events: readonly Event[],
  sessionId: string,
): number | undefined => {
  const finish = events.findLast((event) => RUN_ENDED.has(event.type));
  if (finish === undefined) return undefined;
  const started = events.findLast((event) => startedSession(event) === sessionId);
  return started === undefined || started.seq < finish.seq ? finish.seq : undefined;
};

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
  mode: NodeRun["mode"];
}>;

export type StopCheck = Readonly<{
  run: RunRef;
  state: State;
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
// worked on is the running entry of any other type; with several open, the session's inline one.
const CONTAINERS: ReadonlySet<NodeRun["nodeType"]> = new Set(["loop", "switch", "include"]);

const findActiveLeaf = (nodeRuns: Readonly<Record<string, NodeRun>>): ActiveLeaf | undefined => {
  const leaf = findRunningLeaf(nodeRuns);
  if (leaf === undefined || CONTAINERS.has(leaf.run.nodeType)) return undefined;
  const { path, run } = leaf;
  return {
    nodeId: path.slice(path.lastIndexOf(".") + 1),
    nodeRunId: run.nodeRunId,
    nodeType: run.nodeType,
    awaitingApproval: run.awaitingApproval,
    mode: run.mode,
  };
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
  // The task's end wakes the agent, so a turn that waits on it is neither a lapse nor stuck. An
  // inline node is the session's own work, so background work beside it never excuses its done.
  const owesInline = position.kind === "open-node" && position.leaf.mode === "inline";
  if (waitingOnBackground && (!owesInline || prior >= maxBlocks)) {
    return { reason: "background-task", blockStreak: prior };
  }
  if (position.kind === "between-nodes" && touchedRun === false)
    return { reason: "user-chat", blockStreak: prior };
  // No one answers, so the agent is sent back each time, and fails the node once it keeps stopping.
  const { interaction } = readPolicies(state.policies);
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
  toolCalls: number | undefined,
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
    ...(toolCalls === undefined ? {} : { toolCalls }),
  },
});

// A turn between nodes reads touchedRun from the transcript. An unattended agent node counts its
// tool calls, since its work leaves no run event and a stop after real work is not a lapse. A
// question is not work: the guard refuses it, and an agent that keeps asking must still fail.
const readTranscriptFacts = async (
  input: StopInput,
  state: State,
): Promise<Readonly<{ touchedRun: boolean | undefined; toolCalls: number | undefined }>> => {
  const position = positionOf(state);
  const unattendedNode =
    !readPolicies(state.policies).interaction &&
    position.kind === "open-node" &&
    position.leaf.nodeType === "agent";
  if (position.kind !== "between-nodes" && !unattendedNode) {
    return { touchedRun: undefined, toolCalls: undefined };
  }
  const entries = await input.readTranscript();
  return {
    touchedRun: position.kind === "between-nodes" ? touchedRunSinceLastPrompt(entries) : undefined,
    toolCalls: entries?.filter((entry) => entry.kind === "command" || entry.kind === "tool").length,
  };
};

// A transcript lists a tool call before the guards decide on it, so a call yok denied is not
// work. A refused question is no tool call in the transcript, so its denial is not taken off.
const isDeniedCall = (event: Event): boolean => {
  const called = PreToolUseCalledEvent.safeParse(event);
  return (
    called.success &&
    called.data.payload.decision === "deny" &&
    called.data.payload.handler !== "question-guard"
  );
};

// Whether the transcript holds more tool calls than it did at the last check, less those denied.
const workedSince = (
  events: readonly Event[],
  seq: number | undefined,
  toolCalls: number | undefined,
): boolean => {
  const last = StopCalledEvent.safeParse(events.find((event) => event.seq === seq));
  const before = last.success ? last.data.payload.toolCalls : undefined;
  if (toolCalls === undefined || before === undefined || seq === undefined) return false;
  const denied = events.filter((event) => event.seq > seq && isDeniedCall(event)).length;
  return toolCalls - before > denied;
};

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
    const [{ touchedRun, toolCalls }, events] = await Promise.all([
      readTranscriptFacts(input, state),
      jsonlEventStore(runDir).read(),
    ]);
    const seq = state.stopHook?.seq;
    const check = {
      run,
      state,
      touchedRun,
      progressSinceCheck: progressSince(events, seq) || workedSince(events, seq, toolCalls),
      maxBlocks: maxBlocksOf(deps.env),
      waitingOnBackground: input.waitingOnBackground,
      pendingSwitch: foldModelSwitch(events, state.tiers).pending,
    };
    const decision = await decideForAgent(input, check);
    const stored = await appendRunEvent(run, stopCalledEvent(input, check, decision, toolCalls));
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
    const finishSeq =
      decision.reason === "run-finished" ? finishedBySession(events, input.sessionId) : undefined;
    if (finishSeq !== undefined) await startCloseStep(run, input.sessionId, finishSeq);
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

// `git push` or `git -C dir push`, but not `git commit -m "fix and push"`
const PUSH = /(?:^|[\s;&|(])git\s+(?:-[Cc]\s+\S+\s+|-\S+\s+)*push\b/;
// the command learn runs last, which marks everything said so far as looked at
const LEARN_MARK = /\bemit\s+learning\.reviewed\b/;
const LEARN_OFFER =
  "You pushed changes after the run's PR was created. If nothing the user said since the last " +
  "learning session corrected you, reply only with: No new learnings from your messages. Otherwise ask the user one question: " +
  "start a learning session now, from their corrections since the last one? If they say yes, run " +
  `the learn skill (/yok:learn) with trigger auto. If they say no, end your turn. ${ASK_RULE}`;
const OfferedEvent = z.object({
  type: z.literal("learning.offered"),
  payload: z.object({ prompts: z.int() }),
});

type LearnOffer = Readonly<{ kind: "allow" }> | Readonly<{ kind: "offer"; prompts: number }>;

const lastCommandIndex = (entries: readonly TranscriptEntry[], pattern: RegExp): number =>
  entries.findLastIndex((entry) => entry.kind === "command" && pattern.test(entry.command));

// The agent pushed since the user's last message, and that message came after the last learning
// session, so it may hold a correction no session has looked at.
const pushedAfterNewPrompt = (entries: readonly TranscriptEntry[]): boolean => {
  const lastPrompt = entries.findLastIndex((entry) => entry.kind === "prompt");
  return (
    lastCommandIndex(entries, PUSH) > lastPrompt &&
    lastPrompt > lastCommandIndex(entries, LEARN_MARK)
  );
};

export const decideLearnOffer = (
  events: readonly Event[],
  entries: readonly TranscriptEntry[] | undefined,
): LearnOffer => {
  if (entries === undefined || !pushedAfterNewPrompt(entries)) return { kind: "allow" };
  const prompts = entries.filter((entry) => entry.kind === "prompt").length;
  const offered = events.some(
    (event) => OfferedEvent.safeParse(event).data?.payload.prompts === prompts,
  );
  return offered ? { kind: "allow" } : { kind: "offer", prompts };
};

// Never throws, like the workflow's Stop handler: a failure lets the turn end.
const runLearnOffer = async (input: StopInput, deps: HookDeps): Promise<HookReply> => {
  try {
    const run = await findSessionRun(input, deps);
    if (run === undefined) return ALLOW;
    const runDir = runDirOf(run.cwd, run.name);
    const state = await readState(runDir);
    if (state?.nodeRuns.pr?.status !== "completed") return ALLOW;
    const [events, entries] = await Promise.all([
      jsonlEventStore(runDir).read(),
      input.readTranscript(),
    ]);
    // The session closes once the run ends in it, so an offer there would be cut off. This check
    // repeats runStopHook's because the two handlers run at the same stop without seeing each other.
    if (!isRunLive(state.status) && finishedBySession(events, input.sessionId) !== undefined) {
      return ALLOW;
    }
    const offer = decideLearnOffer(events, entries);
    if (offer.kind === "allow") return ALLOW;
    const stored = await appendRunEvent(run, {
      type: "learning.offered",
      source: "hooks",
      payload: { prompts: offer.prompts },
    });
    if (!stored.ok) {
      // An unrecorded offer would be made again at every stop.
      deps.log.warn({ error: stored.error }, "learn not offered: the offer was not recorded");
      return ALLOW;
    }
    return { kind: "continue", message: LEARN_OFFER };
  } catch (error) {
    deps.log.error({ err: error }, "learn not offered: the offer check failed");
    return ALLOW;
  }
};

// Runs when the agent finishes a reply. If the run's `pr` stage has completed, the agent ran
// `git push` since the user's last message, and that message came after the last learning
// session, it sends the agent LEARN_OFFER. The agent asks the user if it can start a learning
// session only if there are user corrections since the previous learning session.
export const offerLearn: StopHandler = { name: "offer-learn", run: runLearnOffer };

// The handlers an agent can register, by the name `orchestrate hook stop --handler` takes.
export const stopHandlers: Readonly<Record<string, StopHandler>> = Object.fromEntries(
  [continueWorkflow, offerLearn].map((handler) => [handler.name, handler]),
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
