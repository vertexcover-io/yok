import { notifierHooks } from "@yok/core";
import type { ILogger, Source, Thread } from "@yok/sdk";
import * as z from "zod";
import type { YokClient } from "./client.ts";
import { type ChannelReply, runChannelCommand } from "./commands.ts";
import type { SlackKeys } from "./protocol.ts";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type SlackDeps = Readonly<{
  keys: SlackKeys;
  client: YokClient;
  log: ILogger;
  fetch: Fetch;
  // wait before opening a new socket after one drops or fails to open
  reconnectMs: number;
  // how often the socket is pinged; one unanswered by the next ping is dropped
  pingMs: number;
  // the longest stop() waits for commands already being answered
  stopWaitMs: number;
}>;

const SLACK_API = "https://slack.com/api";

const SlackReplySchema = z.looseObject({
  ok: z.boolean(),
  error: z.string().optional(),
  ts: z.string().optional(),
  url: z.string().optional(),
});
type SlackReply = z.infer<typeof SlackReplySchema>;

const SlashPayloadSchema = z.looseObject({
  text: z.string(),
  user_id: z.string(),
  user_name: z.string().optional(),
  channel_id: z.string(),
  response_url: z.string(),
});
type SlashPayload = z.infer<typeof SlashPayloadSchema>;

const EnvelopeSchema = z.looseObject({
  type: z.string(),
  envelope_id: z.string().optional(),
  payload: z.unknown().optional(),
});

const callSlack = async (
  fetch: Fetch,
  token: string,
  method: string,
  body: Readonly<Record<string, unknown>>,
): Promise<SlackReply> => {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  const json: unknown = await res.json().catch(() => undefined);
  return SlackReplySchema.safeParse(json).data ?? { ok: false, error: `http ${res.status}` };
};

// Slack escapes &, < and > in command text, and a Mac types quotes curly.
export const readCommandText = (text: string): string =>
  text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");

// A zero-width space between backticks keeps a ``` in the text from closing the code block.
const breakFences = (text: string): string => text.replace(/`(?=`)/g, "`​");

const formatReply = (reply: ChannelReply) => ({
  text: `${reply.ok ? "" : "❌ "}\`\`\`${breakFences(notifierHooks.escapeSlack(reply.text))}\`\`\``,
  ...(reply.rows === undefined
    ? {}
    : {
        blocks: [
          {
            type: "table",
            rows: reply.rows.map((row) => row.map((text) => ({ type: "raw_text", text }))),
          },
        ],
      }),
});

// The response_url reaches only the person who typed, and needs no channel membership.
const replyPrivately = async (fetch: Fetch, payload: SlashPayload, text: string): Promise<void> => {
  await fetch(payload.response_url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response_type: "ephemeral", text }),
  });
};

// Every command opens a thread, so the adapter needs no knowledge of which commands start runs.
export const answerSlashCommand = async (payload: SlashPayload, deps: SlackDeps): Promise<void> => {
  const { fetch, keys } = deps;
  const text = readCommandText(payload.text);
  const channel = payload.channel_id;
  if (!keys.allowedChannels.includes(channel)) {
    return replyPrivately(
      fetch,
      payload,
      `/yok is not turned on in this channel. Add ${channel} to SLACK_ALLOWED_CHANNELS in the yok home's .env, then restart the server.`,
    );
  }
  const opened = await callSlack(fetch, keys.botToken, "chat.postMessage", {
    channel,
    text: `⏳ <@${payload.user_id}> /yok ${notifierHooks.escapeSlack(text)}`,
  });
  if (!opened.ok || opened.ts === undefined) {
    return replyPrivately(
      fetch,
      payload,
      `I can't post in this channel (${opened.error ?? "no ts"}). Invite the yok app to it, then try again.`,
    );
  }
  const source: Source = {
    channel: "slack",
    id: payload.user_id,
    ...(payload.user_name === undefined ? {} : { name: payload.user_name }),
    place: channel,
  };
  const thread: Thread = { place: channel, threadId: opened.ts, memberId: payload.user_id };
  const reply = await runChannelCommand(text, source, deps.client, thread);
  const formatted = formatReply(reply);
  const posted = await callSlack(fetch, keys.botToken, "chat.postMessage", {
    channel,
    thread_ts: opened.ts,
    ...formatted,
  });
  if (posted.ok) return;
  deps.log.warn({ error: posted.error }, "slack: the reply was not posted");
  // Slack refuses a table over 100 rows, but takes the same reply as text.
  const retried = await callSlack(fetch, keys.botToken, "chat.postMessage", {
    channel,
    thread_ts: opened.ts,
    text: formatted.text,
  });
  if (!retried.ok) await replyPrivately(fetch, payload, formatted.text);
};

// Bun's client socket has these; the DOM WebSocket type the checker sees does not.
type BunSocket = WebSocket & Readonly<{ ping: () => void; terminate: () => void }>;
const isBunSocket = (ws: WebSocket): ws is BunSocket => "ping" in ws && "terminate" in ws;

// A frame that is not JSON is dropped, never thrown inside the socket's handler.
const parseFrame = (data: unknown): unknown => {
  try {
    return JSON.parse(String(data));
  } catch {
    return undefined;
  }
};

// Never logs the socket URL: its ticket lets anyone holding it read the app's events.
export const startSlackAdapter = (deps: SlackDeps): Readonly<{ stop: () => Promise<void> }> => {
  const { log } = deps;
  const answering = new Set<Promise<void>>();
  let stopped = false;
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const receive = (ws: WebSocket, data: unknown): void => {
    const envelope = EnvelopeSchema.safeParse(parseFrame(data)).data;
    if (envelope === undefined) return;
    if (envelope.type === "hello") log.info({}, "slack connected");
    // Slack sends disconnect before it refreshes a socket: the next one opens at once,
    // since the reconnect wait is for failures.
    if (envelope.type === "disconnect") {
      ws.onclose = attempt;
      ws.close();
    }
    if (envelope.type !== "slash_commands" || envelope.envelope_id === undefined) return;
    // Acknowledged first: Slack shows the person an error after three seconds without it.
    ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    const payload = SlashPayloadSchema.safeParse(envelope.payload).data;
    if (payload === undefined) return;
    const answer = answerSlashCommand(payload, deps).catch((error: unknown) =>
      log.error({ err: String(error) }, "slack: a command failed"),
    );
    answering.add(answer);
    void answer.finally(() => answering.delete(answer));
  };

  // A half-open socket (after sleep or a network change) never closes by itself.
  const watch = (ws: WebSocket): void => {
    if (!isBunSocket(ws)) return;
    let heard = true;
    const hear = (): void => {
      heard = true;
    };
    ws.addEventListener("message", hear);
    ws.addEventListener("pong", hear);
    const tick = setInterval(() => {
      if (!heard) return ws.terminate();
      heard = false;
      ws.ping();
    }, deps.pingMs);
    ws.addEventListener("close", () => clearInterval(tick));
  };

  const connect = async (): Promise<void> => {
    const opened = await callSlack(deps.fetch, deps.keys.appToken, "apps.connections.open", {});
    if (!opened.ok || opened.url === undefined) {
      log.warn({ error: opened.error }, "slack: no socket; trying again");
      return later();
    }
    if (stopped) return;
    const ws = new WebSocket(opened.url);
    socket = ws;
    ws.onopen = () => watch(ws);
    ws.onmessage = (message) => receive(ws, message.data);
    ws.onclose = later;
  };

  const attempt = (): void => {
    if (stopped) return;
    connect().catch((error: unknown) => {
      log.error({ err: String(error) }, "slack: connecting failed");
      later();
    });
  };

  const later = (): void => {
    if (!stopped) retry = setTimeout(attempt, deps.reconnectMs);
  };

  attempt();
  return {
    // A command already being answered may be starting a run; cutting it off leaves a
    // half-started run and a thread stuck on its opener.
    stop: async () => {
      stopped = true;
      clearTimeout(retry);
      socket?.close();
      await Promise.race([Promise.allSettled(answering), Bun.sleep(deps.stopWaitMs)]);
    },
  };
};
