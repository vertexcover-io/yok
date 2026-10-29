import { createHmac, timingSafeEqual } from "node:crypto";
import { notifierHooks } from "@yok/core";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import * as z from "zod";
import { type ChatThread, type DispatchDeps, dispatchCommand } from "./dispatch.ts";
import { readHomeEnv } from "./protocol.ts";

// Slack's own replay window for a signed request.
const MAX_AGE_S = 5 * 60;
// Slack retries an unanswered event within minutes; this many ids spans them.
const SEEN_LIMIT = 1000;

export type SlackHookDeps = DispatchDeps &
  Readonly<{
    home: string;
    // what calls Slack's Web API; the network's fetch outside tests
    slackFetch: notifierHooks.Fetch;
    now: () => Date;
  }>;

// Slack signs every request: v0= and the hex HMAC-SHA256 of "v0:TIMESTAMP:BODY" under the
// app's signing secret.
export const isSlackSigned = (
  secret: string,
  timestamp: string,
  body: string,
  signature: string,
  now: Date,
): boolean => {
  const sent = Number(timestamp);
  if (!Number.isInteger(sent) || Math.abs(now.getTime() / 1000 - sent) > MAX_AGE_S) return false;
  const expected = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return (
    expected.length === signature.length &&
    timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  );
};

// The signature covers the exact bytes, so the body is read as text before anything parses it;
// Hono caches it, so the handler's c.req.json() still works.
const verifySlack =
  (deps: SlackHookDeps): MiddlewareHandler =>
  async (c, next) => {
    const secret = readHomeEnv(deps.home).SLACK_SIGNING_SECRET;
    if (!secret)
      return c.text("the Slack hook is not set up: SLACK_SIGNING_SECRET is missing", 503);
    const signed = isSlackSigned(
      secret,
      c.req.header("x-slack-request-timestamp") ?? "",
      await c.req.text(),
      c.req.header("x-slack-signature") ?? "",
      deps.now(),
    );
    if (!signed) return c.text("bad signature", 401);
    await next();
  };

const MentionSchema = z.looseObject({
  type: z.string(),
  channel: z.string(),
  ts: z.string(),
  text: z.string(),
  // set when the mention was typed inside a thread
  thread_ts: z.string().optional(),
});
type Mention = z.infer<typeof MentionSchema>;

const PayloadSchema = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("url_verification"), challenge: z.string() }),
  z.looseObject({ type: z.literal("event_callback"), event_id: z.string(), event: MentionSchema }),
]);

// A code block shows the reply as typed; a run of three backticks inside it would close it early.
const codeBlock = (text: string): string =>
  `\`\`\`\n${notifierHooks.escapeSlack(text).replaceAll("```", "`\u200b``")}\n\`\`\``;

const postReply = async (config: notifierHooks.SlackConfig, ts: string, text: string) => {
  await notifierHooks.callSlack(config, "chat.postMessage", {
    channel: config.channel,
    thread_ts: ts,
    text: codeBlock(text),
  });
};

// The bot's own mention opens the text: <@U0BOT> run task …
const commandText = (text: string): string => text.replace(/^\s*<@[A-Z0-9]+>\s*/, "");

const answerMention = async (mention: Mention, deps: SlackHookDeps): Promise<void> => {
  const thread: ChatThread = { channel: mention.channel, ts: mention.thread_ts ?? mention.ts };
  const log = deps.log.child({ component: "slack", thread: thread.ts });
  const token = readHomeEnv(deps.home).SLACK_BOT_TOKEN;
  if (!token) {
    log.error({}, "SLACK_BOT_TOKEN is not set, so the mention gets no reply");
    return;
  }
  const config = { token, channel: thread.channel, memberId: undefined, fetch: deps.slackFetch };
  const say = (text: string) => postReply(config, thread.ts, text);
  try {
    await say(await dispatchCommand(commandText(mention.text), thread, deps, say));
  } catch (error) {
    log.error({ err: error }, "the Slack command failed");
    // the error can name host paths; the channel gets a fixed line and the log the detail
    await say("internal: the command failed; see the server log").catch(() => undefined);
  }
};

// Mounted at /api/hooks/slack by createRoot, outside the API so the client never sees it. The ack
// goes back before the command runs: a run start outlasts Slack's 3 seconds, and Slack retries
// an unanswered event, which `seen` drops by event_id.
export const slackHookRoutes = (deps: SlackHookDeps) => {
  const seen = new Set<string>();
  return new Hono().post("/", verifySlack(deps), async (c) => {
    const payload = PayloadSchema.safeParse(await c.req.json().catch(() => null));
    if (!payload.success) return c.body(null, 200);
    if (payload.data.type === "url_verification") {
      return c.json({ challenge: payload.data.challenge }, 200);
    }
    const { event_id: eventId, event } = payload.data;
    const allowed = readHomeEnv(deps.home).SLACK_COMMAND_CHANNEL;
    if (event.type !== "app_mention" || event.channel !== allowed || seen.has(eventId)) {
      return c.body(null, 200);
    }
    seen.add(eventId);
    const oldest = seen.values().next().value;
    if (seen.size > SEEN_LIMIT && oldest !== undefined) seen.delete(oldest);
    void answerMention(event, deps);
    return c.body(null, 200);
  });
};
