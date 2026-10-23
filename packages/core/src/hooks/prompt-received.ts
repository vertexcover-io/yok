import type { PromptReceivedHandler } from "@yok/sdk";
import { digestLine } from "../agents/common.ts";
import { recordSessionEvent } from "./common.ts";

// Tells the helper that typed a line that the agent took it.
export const recordPromptReceived: PromptReceivedHandler = {
  name: "record-prompt-received",
  run: async ({ agent, sessionId, line }, deps) => {
    const payload = { agent, sessionId, digest: digestLine(line) };
    await recordSessionEvent(
      { agent, sessionId },
      { type: "hooks.prompt-received.called", payload },
      deps,
    );
  },
};

export const promptReceivedHandlers: Readonly<Record<string, PromptReceivedHandler>> =
  Object.fromEntries([recordPromptReceived].map((handler) => [handler.name, handler]));
