import { findOpenContextRun, type WorkflowAgent, WorkflowAgentSchema } from "@yok/core";
import type {
  IAgentProvider,
  ILogger,
  IStorage,
  ITerminalHost,
  State,
  WorkflowRun,
} from "@yok/sdk";
import { emitRunEvent } from "@yok/sdk";
import { deliveryMessage, isRunLive } from "@yok/sdk/internal";

export type DeliveryOutcome =
  | Readonly<{ kind: "delivered"; ids: readonly string[] }>
  | Readonly<{ kind: "waiting"; reason: string }>
  | Readonly<{ kind: "nothing" }>
  | Readonly<{ kind: "failed"; reason: string }>;

export type DeliveryDeps = Readonly<{
  storage: IStorage;
  providerFor: (agent: WorkflowAgent) => IAgentProvider;
  host: ITerminalHost;
  log: ILogger;
}>;

const RETRY_MS = 2000;

const waiting = (reason: string): DeliveryOutcome => ({ kind: "waiting", reason });

// A stored state that does not parse reads as no state, so one bad engine write blanks nothing.
export const readStateOrNull = (storage: IStorage, runId: string): Promise<State | null> =>
  storage.runs.readState(runId).catch(() => null);

export const isAgentAlive = async (run: WorkflowRun, host: ITerminalHost): Promise<boolean> =>
  run.terminal !== null && (await host.find(run.terminal).isAlive());

// A run names itself in its first minute. One still unnamed 5 minutes after it was started has
// stalled, so it no longer counts as going.
const STARTING_MS = 5 * 60 * 1000;

// since: when the run was started, which decides whether an unnamed run has stalled
export const isRunGoing = async (
  run: WorkflowRun,
  since: string,
  deps: Readonly<{ storage: IStorage; host: ITerminalHost; now: () => Date }>,
): Promise<boolean> => {
  if (!(await isAgentAlive(run, deps.host))) return false;
  if (run.name === null) return deps.now().getTime() - new Date(since).getTime() < STARTING_MS;
  const state = await readStateOrNull(deps.storage, run.id);
  return state === null || isRunLive(state.status);
};

export const deliverComments = async (
  run: WorkflowRun,
  deps: DeliveryDeps,
): Promise<DeliveryOutcome> => {
  if (run.name === null) return waiting("run has no name yet");
  const sent = (await deps.storage.comments.list(run.id)).filter((c) => c.status === "sent");
  if (sent.length === 0) return { kind: "nothing" };

  // Not retried: yok resume schedules a delivery once the session is back, and the next comment
  // or reply on the run tries again.
  if (run.terminal === null || !(await isAgentAlive(run, deps.host))) {
    return { kind: "failed", reason: "agent session is not running" };
  }
  const pane = deps.host.find(run.terminal);
  const state = await readStateOrNull(deps.storage, run.id);
  if (state !== null && findOpenContextRun(state.nodeRuns) !== undefined) {
    return waiting("agent is clearing its context");
  }

  // The run's agent is the one its first session belongs to; the start hook links it.
  const agent = WorkflowAgentSchema.safeParse(run.sessions[0]?.agent);
  if (!agent.success) return waiting("agent session is not linked yet");
  const provider = deps.providerFor(agent.data);
  const message = deliveryMessage(sent, run.name);
  const typed = await provider.promptWhenReady(pane, message, { whileBusy: true });
  if (!typed.ok) return waiting(typed.error);
  if (typed.value === "not-ready") return waiting("agent has a menu open or text in its input box");
  const ids = sent.map((c) => c.id);
  await deps.storage.comments.markDelivered(run.id, sent);
  const logged = await emitRunEvent(
    { id: run.id, cwd: run.cwd, name: run.name },
    { type: "artifact.comment.delivered", source: "viewer", payload: { ids } },
    deps.storage,
  );
  if (!logged.ok)
    deps.log.error({ runId: run.id, error: logged.error }, "delivery event not logged");
  return { kind: "delivered", ids };
};

const outcomes = new Map<string, DeliveryOutcome>();
const retries = new Map<string, Timer>();
const attempts = new Map<string, Promise<void>>();

export const lastDelivery = (runId: string): DeliveryOutcome | undefined => outcomes.get(runId);

const attempt = async (runId: string, deps: DeliveryDeps): Promise<void> => {
  const run = await deps.storage.runs.findRun(runId);
  if (run === undefined) return;
  const outcome = await deliverComments(run, deps);
  outcomes.set(runId, outcome);
  if (outcome.kind === "failed")
    deps.log.error({ runId, reason: outcome.reason }, "delivery failed");
  if (outcome.kind !== "waiting" || retries.has(runId)) return;
  retries.set(
    runId,
    setTimeout(() => {
      retries.delete(runId);
      void scheduleDelivery(runId, deps);
    }, RETRY_MS),
  );
};

// Attempts for one run queue behind each other so a batch posted mid-delivery is not typed twice;
// a run already waiting on a retry needs no second one. The last attempt in line clears the entry.
export const scheduleDelivery = (runId: string, deps: DeliveryDeps): Promise<void> => {
  if (retries.has(runId)) return Promise.resolve();
  const next: Promise<void> = (attempts.get(runId) ?? Promise.resolve())
    .then(() => attempt(runId, deps))
    .catch((error: unknown) => deps.log.error({ runId, err: error }, "delivery threw"))
    .finally(() => {
      if (attempts.get(runId) === next) attempts.delete(runId);
    });
  attempts.set(runId, next);
  return next;
};

export const resumeDeliveries = async (deps: DeliveryDeps): Promise<void> => {
  for (const run of await deps.storage.runs.listRuns()) {
    if (run.name === null) continue;
    const comments = await deps.storage.comments.list(run.id);
    if (comments.some((c) => c.status === "sent")) void scheduleDelivery(run.id, deps);
  }
};

export const stopDeliveries = (): void => {
  for (const timer of retries.values()) clearTimeout(timer);
  retries.clear();
};
