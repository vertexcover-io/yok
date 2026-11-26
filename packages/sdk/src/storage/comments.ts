import { and, eq, inArray } from "drizzle-orm";
import { type Comment, CommentSchema } from "../comments.ts";
import type { Result } from "../contracts.ts";
import type { CommentDraft } from "../events.ts";
import type { ICommentRepository } from "../repositories.ts";
import * as tables from "../schema.ts";
import { type Db, IMMEDIATE, now } from "./common.ts";

type CommentRow = typeof tables.comments.$inferSelect;

const toComment = (row: CommentRow): Comment =>
  CommentSchema.parse({
    id: row.id,
    file: row.file,
    kind: row.kind,
    text: row.text,
    status: row.status,
    createdAt: row.createdAt,
    ...(row.deliveredAt === null ? {} : { deliveredAt: row.deliveredAt }),
    ...(row.anchor === null ? {} : { anchor: row.anchor }),
    thread: row.thread,
  });

const commentNumber = (id: string): number => Number.parseInt(id.slice(1), 10) || 0;

const selectComments = (db: Db, runId: string): readonly Comment[] =>
  db
    .select()
    .from(tables.comments)
    .where(eq(tables.comments.runId, runId))
    .all()
    .map(toComment)
    .toSorted((a, b) => commentNumber(a.id) - commentNumber(b.id));

const userWords = (draft: CommentDraft): string => {
  if (draft.kind === "delete")
    return `Delete this.${draft.text.trim() === "" ? "" : ` ${draft.text}`}`;
  if (draft.kind === "replace") return `Replace with “${draft.text}”`;
  return draft.text;
};

// Numbered from the highest cN, not the row count, so ids match the ones comments.json held.
const insertComments = (
  db: Db,
  runId: string,
  drafts: readonly CommentDraft[],
  at: string,
): readonly Comment[] =>
  db.transaction((tx) => {
    const first = Math.max(0, ...selectComments(tx, runId).map((c) => commentNumber(c.id))) + 1;
    const added = drafts.map(
      (draft, i): Comment => ({
        ...draft,
        id: `c${first + i}`,
        status: "sent",
        createdAt: at,
        thread: [{ by: "user", text: userWords(draft), at }],
      }),
    );
    tx.insert(tables.comments)
      .values(added.map((comment) => ({ ...comment, runId, updatedAt: at })))
      .run();
    return added;
  }, IMMEDIATE);

const updateComment = (
  db: Db,
  runId: string,
  id: string,
  change: (comment: Comment) => Comment,
): Result<Comment> =>
  db.transaction((tx): Result<Comment> => {
    const where = and(eq(tables.comments.runId, runId), eq(tables.comments.id, id));
    const row = tx.select().from(tables.comments).where(where).get();
    if (row === undefined) return { ok: false, error: `no comment ${id}` };
    const updated = change(toComment(row));
    tx.update(tables.comments)
      .set({ status: updated.status, thread: updated.thread })
      .where(where)
      .run();
    return { ok: true, value: updated };
  }, IMMEDIATE);

// `typed` is the comments as they were when typed into the session. One that gained a thread
// entry since (a user reply posted mid-delivery) stays sent, so its new words go out next time.
const markCommentsDelivered = (
  db: Db,
  runId: string,
  typed: readonly Comment[],
  at: string,
): readonly Comment[] =>
  db.transaction((tx) => {
    const marked = selectComments(tx, runId)
      .filter(
        (comment) =>
          comment.status === "sent" &&
          typed.some((t) => t.id === comment.id && t.thread.length === comment.thread.length),
      )
      .map((comment): Comment => ({ ...comment, status: "delivered", deliveredAt: at }));
    if (marked.length === 0) return marked;
    const ids = marked.map((comment) => comment.id);
    tx.update(tables.comments)
      .set({ status: "delivered", deliveredAt: at })
      .where(and(eq(tables.comments.runId, runId), inArray(tables.comments.id, ids)))
      .run();
    return marked;
  }, IMMEDIATE);

// The time is read before each transaction: its callback is synchronous and must await nothing.
export const commentRepository = (db: Db): ICommentRepository => ({
  list: async (runId) => selectComments(db, runId),
  add: async (runId, drafts) =>
    drafts.length === 0 ? [] : insertComments(db, runId, drafts, now()),
  addUserReply: async (runId, id, text) => {
    const at = now();
    return updateComment(db, runId, id, (comment) => ({
      ...comment,
      status: "sent",
      thread: [...comment.thread, { by: "user", text, at }],
    }));
  },
  reply: async (runId, id, reply) => {
    if (reply.text.trim() === "") return { ok: false, error: "the reply has no text" };
    const at = now();
    return updateComment(db, runId, id, (comment) => ({
      ...comment,
      status: reply.status,
      thread: [...comment.thread, { by: "agent", text: reply.text, at }],
    }));
  },
  markDelivered: async (runId, typed) => markCommentsDelivered(db, runId, typed, now()),
  importComments: async (runId, imported) => {
    const at = now();
    db.transaction((tx) => {
      for (const comment of imported) {
        tx.insert(tables.comments)
          .values({ ...comment, runId, updatedAt: at })
          .onConflictDoNothing()
          .run();
      }
    }, IMMEDIATE);
  },
});
