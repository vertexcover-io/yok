import type { HookDeps, StopFailureHandler, StopFailureInput, TranscriptEntry } from "@yok/sdk";
import { startAutoResume } from "../auto-resume.ts";
import { recordSessionEvent } from "./common.ts";

const buildErrorPayload = ({ agent, sessionId, error, message }: StopFailureInput) => ({
  agent,
  sessionId,
  error,
  ...(message === undefined ? {} : { message }),
});

// A tool called since the last message the agent was sent, such as yok's continue: the session got
// somewhere before this error, so the error count starts again.
const madeProgress = (entries: readonly TranscriptEntry[]): boolean =>
  entries.slice(entries.findLastIndex((entry) => entry.kind === "prompt") + 1).length > 0;

const recordAndWait = async (
  input: StopFailureInput,
  event: Readonly<{ type: string; payload: Readonly<Record<string, string | boolean>> }>,
  deps: HookDeps,
): Promise<void> => {
  const recorded = await recordSessionEvent(input, event, deps);
  if (recorded === undefined) return;
  startAutoResume(recorded.run, input.sessionId, recorded.event.id);
};

export const resumeAfterLimit: StopFailureHandler = {
  name: "resume-after-limit",
  run: async (input, deps) => {
    if (!input.usageLimit) return;
    await recordAndWait(
      input,
      { type: "agent.limit.reached", payload: buildErrorPayload(input) },
      deps,
    );
  },
};

// A usage limit is waited out by resume-after-limit. An error that may pass is retried here, not in
// a handler of its own: a session launched before the retry existed lists only this handler.
export const recordAgentError: StopFailureHandler = {
  name: "record-agent-error",
  run: async (input, deps) => {
    if (input.usageLimit) return;
    if (input.retryable) {
      const progressed = madeProgress((await input.readTranscript()) ?? []);
      const payload = { ...buildErrorPayload(input), progressed };
      return recordAndWait(input, { type: "agent.error.reached", payload }, deps);
    }
    await recordSessionEvent(
      input,
      { type: "agent.stopped", payload: buildErrorPayload(input) },
      deps,
    );
  },
};

export const stopFailureHandlers: Readonly<Record<string, StopFailureHandler>> = Object.fromEntries(
  [resumeAfterLimit, recordAgentError].map((handler) => [handler.name, handler]),
);
