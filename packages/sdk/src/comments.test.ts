import { describe, expect, test } from "bun:test";
import { type Comment, deliveryMessage, isOpen } from "./comments.ts";
import { type CommentDraft, CommentDraftSchema } from "./events.ts";

const NOW = new Date("2026-01-01T00:00:00.000Z");

const anchor = { quote: "After saving a batch", before: "b", after: "a" };
const comment = (text: string): CommentDraft => ({
  file: "artifacts/design.md",
  kind: "comment",
  text,
  anchor: { ...anchor, lines: [14, 16], heading: "Approach" },
});
const global = (text: string): CommentDraft => ({
  file: "artifacts/review.md",
  kind: "global",
  text,
});

describe("deliveryMessage", () => {
  test("SC12, SC16, SC23: each comment is one block, ordered by file then first line with the approval last, long quotes are cut, and the reply command closes it", () => {
    const long = "x".repeat(100);
    const base = { status: "sent", createdAt: NOW.toISOString() } as const;
    const user = (text: string) => ({ by: "user" as const, text, at: NOW.toISOString() });
    const comments: readonly Comment[] = [
      {
        ...base,
        id: "c2",
        file: "artifacts/design.md",
        kind: "approve",
        text: "Approved",
        thread: [user("Approved")],
      },
      { ...base, ...comment("Why one file per run?"), id: "c4", thread: [user("Why?")] },
      {
        ...base,
        id: "c5",
        file: "artifacts/design.md",
        kind: "delete",
        text: "",
        anchor: { quote: "retry 3 times", before: "", after: "", lines: [30, 30] },
        thread: [user("Delete this.")],
      },
      {
        ...base,
        id: "c7",
        file: "artifacts/design.md",
        kind: "replace",
        text: "twice",
        anchor: { quote: long, before: "", after: "" },
        thread: [user("Replace")],
      },
      { ...base, ...global("Ship it after finding 2."), id: "c6", thread: [user("Ship")] },
      {
        ...base,
        ...comment("old"),
        id: "c3",
        thread: [
          user("old"),
          { by: "agent", text: "done", at: NOW.toISOString() },
          user("Can we bundle it later?"),
        ],
      },
    ];

    expect(deliveryMessage(comments, "feat-x").split("\n")).toEqual([
      "[review] 6 new comments from the viewer:",
      `c7 · artifacts/design.md · replace "${"x".repeat(80)}…" with "twice"`,
      'c4 · artifacts/design.md:14-16 (Approach) on "After saving a batch"',
      "  Why one file per run?",
      "c3 · reply on its thread: Can we bundle it later?",
      'c5 · artifacts/design.md:30 · delete "retry 3 times"',
      "c6 · artifacts/review.md · whole file",
      "  Ship it after finding 2.",
      "c2 · artifacts/design.md · approved: finish the stage that waits on it",
      "Reply to each: yok orchestrate comments reply --run feat-x --id ID --status answered|changed|declined --text -",
    ]);
  });
});

describe("deliveryMessage follow-ups", () => {
  test("a follow-up on a comment the agent never saw goes out with the comment, not instead of it", () => {
    const at = NOW.toISOString();
    const notYetDelivered: Comment = {
      ...comment("Why one file per run?"),
      id: "c1",
      status: "sent",
      createdAt: at,
      thread: [
        { by: "user", text: "Why one file per run?", at },
        { by: "user", text: "and not one per artifact?", at },
      ],
    };
    expect(deliveryMessage([notYetDelivered], "feat-x").split("\n").slice(1, 4)).toEqual([
      'c1 · artifacts/design.md:14-16 (Approach) on "After saving a batch"',
      "  Why one file per run?",
      "  then: and not one per artifact?",
    ]);
    const delivered = { ...notYetDelivered, deliveredAt: at };
    expect(deliveryMessage([delivered], "feat-x").split("\n")[1]).toBe(
      "c1 · reply on its thread: and not one per artifact?",
    );
  });
});

describe("CommentDraftSchema", () => {
  test.each<[string, Readonly<{ anchor?: typeof anchor } & Record<string, unknown>>, boolean]>([
    [
      "SC20: a part-of-file comment with no anchor",
      { file: "artifacts/a.md", kind: "comment", text: "x" },
      false,
    ],
    [
      "SC20: a part-of-file comment with no words",
      { file: "artifacts/a.md", kind: "replace", text: "", anchor },
      false,
    ],
    [
      "SC20: a global comment with a stray anchor, which it keeps,",
      { ...global("x"), anchor },
      true,
    ],
    [
      "SC9: an approve with no anchor",
      { file: "artifacts/design.md", kind: "approve", text: "Approved" },
      true,
    ],
  ])("%s is accepted: %p", (_label, draft, accepted) => {
    const result = CommentDraftSchema.safeParse(draft);
    expect(result.success).toBe(accepted);
    expect(result.data?.anchor).toEqual(accepted ? draft.anchor : undefined);
  });
});

describe("isOpen", () => {
  test("a comment stays open until the agent answers it", () => {
    const at = NOW.toISOString();
    const withStatus = (status: Comment["status"]): Comment => ({
      ...global("x"),
      id: "c1",
      status,
      createdAt: at,
      thread: [{ by: "user", text: "x", at }],
    });
    const open = (["sent", "delivered", "answered", "changed", "declined"] as const).filter((s) =>
      isOpen(withStatus(s)),
    );
    expect(open).toEqual(["sent", "delivered"]);
  });
});
