import * as z from "zod";
import { type JsonValue, NonEmptyStringSchema } from "./contracts.ts";
import {
  type AgentStatusSchema,
  CommentFieldsSchema,
  CommentStatusSchema,
  type EmitInput,
} from "./events.ts";

export const CommentSchema = CommentFieldsSchema.extend({
  id: NonEmptyStringSchema,
  status: CommentStatusSchema,
  createdAt: z.iso.datetime(),
  deliveredAt: z.iso.datetime().optional(),
  thread: z.array(
    z.strictObject({ by: z.enum(["user", "agent"]), text: z.string(), at: z.iso.datetime() }),
  ),
});
export type Comment = z.infer<typeof CommentSchema>;

export type AgentReply = Readonly<{ status: z.infer<typeof AgentStatusSchema>; text: string }>;

export const isOpen = (comment: Comment): boolean =>
  comment.status === "sent" || comment.status === "delivered";

const QUOTE_LIMIT = 80;
const cut = (quote: string): string =>
  quote.length > QUOTE_LIMIT ? `${quote.slice(0, QUOTE_LIMIT)}…` : quote;

const placeOf = (c: Comment): string => {
  const [from, to] = c.anchor?.lines ?? [];
  const lines = from === undefined ? "" : `:${from === to ? from : `${from}-${to}`}`;
  return `${c.id} · ${c.file}${lines}`;
};

// The user's words the agent has not answered: everything after its last reply, or after the
// first entry (the comment itself) when it has not replied yet.
const unansweredWords = (c: Comment): readonly string[] => {
  const lastAgent = c.thread.findLastIndex((entry) => entry.by === "agent");
  return c.thread.slice(Math.max(lastAgent, 0) + 1).map((entry) => entry.text);
};

const blockOf = (c: Comment): string => {
  const words = unansweredWords(c);
  const seenBefore = c.deliveredAt !== undefined || c.thread.some((e) => e.by === "agent");
  if (seenBefore && words.length > 0) return `${c.id} · reply on its thread: ${words.join(" / ")}`;
  return firstBlock(c) + words.map((text) => `\n  then: ${text}`).join("");
};

const firstBlock = (c: Comment): string => {
  const quote = cut(c.anchor?.quote ?? "");
  const words = `\n  ${c.text}`;
  if (c.kind === "approve")
    return `${c.id} · ${c.file} · approved: finish the stage that waits on it`;
  if (c.kind === "global") return `${c.id} · ${c.file} · whole file${words}`;
  if (c.kind === "delete") {
    return `${placeOf(c)} · delete "${quote}"${c.text.trim() === "" ? "" : words}`;
  }
  if (c.kind === "replace") return `${placeOf(c)} · replace "${quote}" with "${c.text}"`;
  const heading = c.anchor?.heading === undefined ? "" : ` (${c.anchor.heading})`;
  return `${placeOf(c)}${heading} on "${quote}"${words}`;
};

// The approval goes last, so the agent reads the other comments before it.
const byPlace = (a: Comment, b: Comment): number => {
  if ((a.kind === "approve") !== (b.kind === "approve")) return a.kind === "approve" ? 1 : -1;
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  return (a.anchor?.lines?.[0] ?? 0) - (b.anchor?.lines?.[0] ?? 0);
};

export const deliveryMessage = (comments: readonly Comment[], runName: string): string =>
  [
    `[review] ${comments.length} new comment${comments.length === 1 ? "" : "s"} from the viewer:`,
    ...[...comments].sort(byPlace).map(blockOf),
    `Reply to each: yok orchestrate comments reply --run ${runName} --id ID --status answered|changed|declined --text -`,
  ].join("\n");

// JSON.stringify drops the optional fields a comment leaves undefined, which a payload may not hold.
const toJson = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value));

export const commentsAddedEvent = (comments: readonly Comment[]): EmitInput => ({
  type: "artifact.comment.added",
  source: "viewer",
  payload: toJson({
    comments: comments.map(({ id, file, kind, text, anchor }) => ({
      id,
      file,
      kind,
      text,
      anchor,
    })),
  }),
});

export const commentRepliedEvent = (
  source: "viewer" | "orchestrate",
  comment: Comment,
): EmitInput => {
  const { id, file, anchor, status, thread } = comment;
  const reply = thread.at(-1);
  return {
    type: "artifact.comment.replied",
    source,
    payload: toJson({ id, by: reply?.by, status, text: reply?.text, file, anchor }),
  };
};
