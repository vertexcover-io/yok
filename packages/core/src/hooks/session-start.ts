import type { SessionStartHandler } from "@yok/sdk";
import { appendRunEvent } from "@yok/sdk/internal";
import { completeContextOnSessionStart } from "../context-step.ts";

// Links by YOK_RUN_ID even before `init` names the run: an agent's first SessionStart comes
// before it runs `init`.
export const linkSession: SessionStartHandler = {
  name: "link-session",
  run: async (input, deps) => {
    const runId = deps.env.YOK_RUN_ID;
    if (!runId) return;
    const run = await deps.storage.runs.findRun(runId);
    if (run === undefined) return;
    const { agent, sessionId, source } = input;
    await deps.storage.runs.linkSession(run.id, { agent, sessionId });
    if (run.name === null) return;
    const ref = { id: run.id, cwd: run.cwd, name: run.name };
    await appendRunEvent(deps.storage, ref, {
      type: "hooks.session-start.called",
      source: "hooks",
      payload: { agent, sessionId, source },
    });
    await completeContextOnSessionStart(deps.storage, ref, sessionId, source);
  },
};

export const sessionStartHandlers: Readonly<Record<string, SessionStartHandler>> =
  Object.fromEntries([linkSession].map((handler) => [handler.name, handler]));
