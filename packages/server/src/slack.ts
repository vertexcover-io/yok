import { createHmac, timingSafeEqual } from "node:crypto";
import { notifierHooks } from "@yok/core";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import * as z from "zod";
import { type DispatchDeps, dispatchCommand } from "./dispatch.ts";
import { readHomeEnv } from "./protocol.ts";
import type { Reply, Table } from "./render.ts";
import type { ChatThread } from "./run.ts";

// Slack's own replay window for a signed request.
const MAX_AGE_S = 5 * 60;
// Slack retries an unanswered event within minutes; this many ids spans them.
const SEEN_LIMIT = 1000;

export type SlackHookDeps = DispatchDeps &
  Readonly<{
    home: string;
    // what calls Slack's Web API; the network's fetch unless a test records the calls
    slackFetch?: notifierHooks.Fetch | undefined;
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

// Slack's limits: 3000 characters in a section's text, and 100 rows and 10,000 characters of
// cells in a table.
const SECTION_LIMIT = 3000;
const TABLE_ROWS = 100;
const TABLE_CHARS = 10_000;

const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text } });

// Lines packed into as few sections as fit; one line is never longer than a section.
const sections = (text: string) =>
  text
    .split("\n")
    .reduce<readonly string[]>((packs, line) => {
      const last = packs.at(-1);
      if (last === undefined || last.length + line.length + 1 > SECTION_LIMIT) {
        return [...packs, line.slice(0, SECTION_LIMIT)];
      }
      return [...packs.slice(0, -1), `${last}\n${line}`];
    }, [])
    .filter((pack) => pack.trim() !== "")
    .map(section);

// raw_text shows a cell as typed, so cells need no escaping; Slack refuses an empty cell.
const cell = (text: string) => ({ type: "raw_text", text: text === "" ? "-" : text });

const headerCell = (text: string) => ({
  type: "rich_text",
  elements: [
    { type: "rich_text_section", elements: [{ type: "text", text, style: { bold: true } }] },
  ],
});

const length = (row: readonly string[]): number =>
  row.reduce((total, text) => total + text.length, 0);

// The leading rows that fit under the header within Slack's limits.
const rowsThatFit = ({ headers, rows }: Table): number => {
  const sizes = rows.slice(0, TABLE_ROWS - 1).map(length);
  const fit = sizes.findIndex(
    (_, index) =>
      length(headers) + sizes.slice(0, index + 1).reduce((a, b) => a + b, 0) > TABLE_CHARS,
  );
  return fit === -1 ? sizes.length : fit;
};

// Every column wraps, so a long path or fix shows whole rather than cut off.
const tableBlock = ({ headers, rows }: Table) => ({
  type: "table",
  column_settings: headers.map(() => ({ is_wrapped: true })),
  rows: [headers.map(headerCell), ...rows.map((row) => row.map(cell))],
});

// A table past Slack's limits shows its leading rows and says how many it left out.
export const toBlocks = (reply: Reply): readonly object[] => {
  const text = sections(notifierHooks.escapeSlack(reply.text));
  const { table } = reply;
  if (table === undefined || table.rows.length === 0) return text;
  const fit = rowsThatFit(table);
  const cut = table.rows.length - fit;
  return [
    ...text,
    tableBlock({ headers: table.headers, rows: table.rows.slice(0, fit) }),
    ...(cut === 0 ? [] : [section(`_${cut} more rows did not fit in this message_`)]),
  ];
};

// The text notifications show; the blocks carry the reply itself.
const postReply = async (config: notifierHooks.SlackConfig, ts: string, reply: Reply) => {
  await notifierHooks.callSlack(config, "chat.postMessage", {
    channel: config.channel,
    thread_ts: ts,
    text: notifierHooks.escapeSlack(reply.text.split("\n")[0] ?? ""),
    blocks: JSON.stringify(toBlocks(reply)),
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
  const config = {
    token,
    channel: thread.channel,
    memberId: undefined,
    fetch: deps.slackFetch ?? fetch,
  };
  const say = (reply: Reply) => postReply(config, thread.ts, reply);
  try {
    await say(await dispatchCommand(commandText(mention.text), thread, deps, say));
  } catch (error) {
    log.error({ err: error }, "the Slack command failed");
    const message = error instanceof Error ? error.message : String(error);
    await say({ text: `internal: ${message}` }).catch(() => undefined);
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
