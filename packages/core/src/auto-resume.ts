import {
  type AgentType,
  ApiErrorReachedEvent,
  type Event,
  type IAgentProvider,
  type ILogger,
  type ITerminal,
  type LimitWaitingEvent,
  type RunRef,
  runDirOf,
} from "@yok/sdk";
import { appendRunEvent, jsonlEventStore } from "@yok/sdk/internal";
import * as z from "zod";
import { spawnOrchestrateHelper } from "./stage.ts";

// With no reset time to read, a retry that hits the limit again schedules the next wait.
const FALLBACK_WAIT_MS = 15 * 60_000;
// 20 fallback waits cover a 5-hour window; past that the limit is one waiting cannot clear,
// such as missing usage credits.
const MAX_LIMITS_IN_A_ROW = 20;
// An API error that may pass is retried after 30s, then 1m, 2m and 4m; the 5th in a row stops
// the agent.
const FIRST_ERROR_WAIT_MS = 30_000;
const MAX_ERRORS_IN_A_ROW = 4;
const CHECK_EVERY_MS = 60_000;
const CONTINUE = "continue";
const LIMIT_REACHED = "agent.limit.reached";
const ERROR_REACHED = "agent.error.reached";

export type AutoResumeOptions = Readonly<{
  run: RunRef;
  sessionId: string;
  // the agent.limit.reached or agent.error.reached event this wait answers
  eventId: string;
  // the agent for each kind the run may use; the limit event says which one stopped
  agents: Readonly<Partial<Record<AgentType, IAgentProvider>>>;
  // the agent's terminal; undefined when the helper cannot reach it
  terminal: ITerminal | undefined;
  log: ILogger;
}>;

type Wait = Readonly<{ ms: number; from: z.infer<typeof LimitWaitingEvent>["payload"]["from"] }>;

type DraftEvent = Readonly<{ type: string; payload: Readonly<Record<string, string>> }>;
// What one wait records: an event when it starts, and an event once continue is typed.
type Retry = Readonly<{ ms: number; waiting: DraftEvent; resumed: DraftEvent }>;
type WaitStart = Readonly<{ sessionId: string; eventId: string; now: Date }>;

const sessionOf = (event: Event): string | undefined =>
  z.looseObject({ payload: z.looseObject({ sessionId: z.string() }) }).safeParse(event).data
    ?.payload.sessionId;

const isActivity = (event: Event): boolean =>
  event.type.startsWith("hooks.") || event.type === LIMIT_REACHED || event.type === ERROR_REACHED;

// The session's hook calls, limit hits and API errors, in order.
const sessionActivity = (events: readonly Event[], sessionId: string): readonly Event[] =>
  events.filter((event) => isActivity(event) && sessionOf(event) === sessionId);

// An API error after the agent called a tool is a new problem, not the last one coming back.
const startsTheCountAgain = (event: Event): boolean =>
  event.type.startsWith("hooks.") ||
  ApiErrorReachedEvent.safeParse(event).data?.payload.progressed === true;

// The trailing run of this type in the session's activity; the other kind of stop neither breaks
// nor extends it.
const countInARow = (activity: readonly Event[], type: string): number => {
  const counted = activity.filter(
    (event) => event.type.startsWith("hooks.") || event.type === type,
  );
  const start = counted.findLastIndex(startsTheCountAgain);
  return counted.slice(Math.max(start, 0)).filter((event) => event.type === type).length;
};

// After this wait's event: the session's own activity, its agent resuming work after a person typed
// to it, or any session starting, which means the terminal may now hold another session, as after
// /clear.
const movedOn = (events: readonly Event[], sessionId: string, eventId: string): boolean =>
  events
    .slice(events.findIndex((event) => event.id === eventId) + 1)
    .some(
      (event) =>
        event.type === "hooks.session-start.called" ||
        ((isActivity(event) || event.type === "agent.resumed") && sessionOf(event) === sessionId),
    );

// False once the session has moved on.
const sleepUnlessMovedOn = async (
  until: number,
  hasMovedOn: () => Promise<boolean>,
): Promise<boolean> => {
  for (let left = until - Date.now(); left > 0; left = until - Date.now()) {
    await Bun.sleep(Math.min(left, CHECK_EVERY_MS));
    if (await hasMovedOn()) return false;
  }
  return !(await hasMovedOn());
};

export const startAutoResume = (run: RunRef, sessionId: string, eventId: string): void =>
  spawnOrchestrateHelper({ command: "auto-resume", id: eventId, run, sessionId });

const planLimitRetry = async (
  agent: IAgentProvider,
  terminal: ITerminal,
  message: string,
  { sessionId, eventId, now }: WaitStart,
): Promise<Retry> => {
  const wait: Wait = (await agent.limitResetWait(terminal, message, now)) ?? {
    ms: FALLBACK_WAIT_MS,
    from: "fallback",
  };
  const ids = { sessionId, limitEventId: eventId };
  const resumeAt = new Date(now.getTime() + wait.ms).toISOString();
  return {
    ms: wait.ms,
    waiting: { type: "agent.limit.waiting", payload: { ...ids, resumeAt, from: wait.from } },
    resumed: { type: "agent.limit.resumed", payload: ids },
  };
};

const planErrorRetry = (
  error: string,
  inARow: number,
  { sessionId, eventId, now }: WaitStart,
): Retry => {
  const ms = FIRST_ERROR_WAIT_MS * 2 ** (inARow - 1);
  const ids = { sessionId, errorEventId: eventId };
  const resumeAt = new Date(now.getTime() + ms).toISOString();
  return {
    ms,
    waiting: { type: "agent.error.waiting", payload: { ...ids, error, resumeAt } },
    resumed: { type: "agent.error.resumed", payload: ids },
  };
};

// Started detached when an agent hits a usage limit or an API error that may pass: waits, then has
// the agent continue in its terminal. When it cannot, it records agent.stopped so a person is told.
export const runAutoResume = async (options: AutoResumeOptions): Promise<void> => {
  const { run, sessionId, eventId, terminal, log } = options;
  const store = jsonlEventStore(runDirOf(run.cwd, run.name));
  const activity = sessionActivity(await store.read(), sessionId);
  const event = activity.find((each) => each.id === eventId);
  // Both kinds of event carry the stop; an API error adds what its hook read of progress.
  const reached = ApiErrorReachedEvent.safeParse(event);
  if (event === undefined || !reached.success)
    return log.warn({ sessionId, eventId }, "auto-resume: no event to answer");
  const { payload } = reached.data;
  const agent = options.agents[payload.agent];
  const isError = event.type === ERROR_REACHED;
  const inARow = countInARow(activity, event.type);
  const max = isError ? MAX_ERRORS_IN_A_ROW : MAX_LIMITS_IN_A_ROW;
  const { progressed: _progressed, message, ...stop } = payload;
  const stopPayload = { ...stop, ...(message === undefined ? {} : { message }) };
  const stopped = { type: "agent.stopped", source: "orchestrate", payload: stopPayload } as const;
  if (terminal === undefined || agent === undefined || inARow > max) {
    await appendRunEvent(run, stopped);
    return log.warn(
      { sessionId, hasTerminal: terminal !== undefined, hasAgent: agent !== undefined, inARow },
      "auto-resume: gave up and recorded agent.stopped",
    );
  }
  const start: WaitStart = { sessionId, eventId, now: new Date() };
  const retry = isError
    ? planErrorRetry(payload.error, inARow, start)
    : await planLimitRetry(agent, terminal, payload.message ?? "", start);
  await appendRunEvent(run, { ...retry.waiting, source: "orchestrate" });
  log.info({ sessionId, waiting: retry.waiting }, "auto-resume started");
  const hasMovedOn = async () => movedOn(await store.read(), sessionId, eventId);
  if (!(await sleepUnlessMovedOn(start.now.getTime() + retry.ms, hasMovedOn)))
    return log.info({ sessionId }, "auto-resume: the session moved on");
  const prompted = await agent.promptWhenReady(terminal, CONTINUE);
  if (!prompted.ok || prompted.value === "not-ready") {
    await appendRunEvent(run, stopped);
    return log.warn(
      { sessionId, prompted },
      "auto-resume: continue not typed; recorded agent.stopped",
    );
  }
  await appendRunEvent(run, { ...retry.resumed, source: "orchestrate" });
  log.info({ sessionId }, "auto-resume: continue typed");
};
