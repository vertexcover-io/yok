import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Event, EventSchema, type Rec, runDirOf } from "@yok/sdk";
import { exchanges, lastReviewedAt, listRun, listSession } from "./candidates.ts";

const at = (minute: number): string => `2026-10-12T10:${String(minute).padStart(2, "0")}:00Z`;

type Row = Readonly<Record<string, unknown>>;

const event = (type: string, ts: string, payload: Row): Event =>
  EventSchema.parse({
    schemaVersion: 1,
    seq: 1,
    id: `${type}@${ts}`,
    ts,
    type,
    source: "test",
    runId: "r-1",
    payload,
  });

const started = (sessionId: string): Event =>
  event("workflow.started", at(0), {
    workflow: "task",
    inputs: {},
    activeSessions: [{ agent: "claude", sessionId }],
  });

const reviewed = (ts: string): Event => event("learning.reviewed", ts, {});

const user = (ts: string, text: string): Row => ({
  type: "user",
  timestamp: ts,
  message: { role: "user", content: text },
});

const agent = (ts: string, text: string): Row => ({
  type: "assistant",
  timestamp: ts,
  message: { role: "assistant", content: [{ type: "text", text }] },
});

const asked = (ts: string, id: string): Row => ({
  type: "assistant",
  timestamp: ts,
  message: {
    role: "assistant",
    content: [{ type: "tool_use", id, name: "AskUserQuestion", input: { questions: [] } }],
  },
});

const answered = (ts: string, id: string, text: string): Row => ({
  type: "user",
  timestamp: ts,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] },
});

const recs = (rows: readonly Row[]): readonly Rec[] =>
  rows.map((data, i) => ({ line: i + 1, data }));

const jsonl = (rows: readonly unknown[]): string =>
  rows.map((row) => JSON.stringify(row)).join("\n");

// A repo with one run folder, beside a fake ~/.claude/projects holding the given transcripts.
const fixture = (
  events: readonly Event[],
  transcripts: Readonly<Record<string, readonly Row[]>>,
): Readonly<{ runDir: string; projectsDir: string }> => {
  const base = mkdtempSync(join(tmpdir(), "learn-"));
  const runDir = runDirOf(base, "run-x");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "event.jsonl"), jsonl(events));
  const projectsDir = join(base, "projects");
  const slug = join(projectsDir, "-Users-x-repo");
  mkdirSync(slug, { recursive: true });
  for (const [id, rows] of Object.entries(transcripts)) {
    writeFileSync(join(slug, `${id}.jsonl`), jsonl(rows));
  }
  return { runDir, projectsDir };
};

describe("the last learn pass", () => {
  test("is the latest learning.reviewed event", () => {
    const events = [started("A"), reviewed(at(5)), reviewed(at(9))];
    expect(lastReviewedAt(events)).toBe(at(9));
  });

  test("is undefined before any pass", () => {
    expect(lastReviewedAt([started("A")])).toBeUndefined();
  });
});

describe("exchanges", () => {
  test("pairs each user message with the end of the agent's reply before it", () => {
    const rows = recs([
      user(at(1), "plan the retry change"),
      agent(at(2), "I put the retry loop in the handler."),
      user(at(3), "no, retries go in the job runner"),
    ]);
    expect(exchanges(rows, undefined)).toEqual([
      { ts: at(1), kind: "TYPED", agent: "", user: "plan the retry change" },
      {
        ts: at(3),
        kind: "TYPED",
        agent: "I put the retry loop in the handler.",
        user: "no, retries go in the job runner",
      },
    ]);
  });

  test("keeps only what came after the last pass", () => {
    const rows = recs([user(at(1), "old"), agent(at(2), "ok"), user(at(6), "new")]);
    expect(exchanges(rows, at(5)).map((e) => e.user)).toEqual(["new"]);
  });

  test("compares times as times, so a message with milliseconds after the pass is kept", () => {
    const rows = recs([user("2026-10-12T10:05:00.500Z", "half a second later")]);
    expect(exchanges(rows, "2026-10-12T10:05:00Z").map((e) => e.user)).toEqual([
      "half a second later",
    ]);
  });

  test("keeps a message with no time rather than dropping a correction", () => {
    const rows = recs([{ type: "user", message: { role: "user", content: "no time on this" } }]);
    expect(exchanges(rows, at(5)).map((e) => e.user)).toEqual(["no time on this"]);
  });

  test("includes answers to the agent's questions, such as a Revise with notes", () => {
    const rows = recs([
      asked(at(1), "q1"),
      answered(at(2), "q1", '"Approve?"="Revise" notes: use the shared logger'),
    ]);
    expect(exchanges(rows, undefined)).toEqual([
      {
        ts: at(2),
        kind: "ANSWER",
        agent: "",
        user: '"Approve?"="Revise" notes: use the shared logger',
      },
    ]);
  });

  test("cuts long messages and agent replies, so a pasted log does not flood the list", () => {
    const rows = recs([agent(at(1), `${"a".repeat(1000)}END`), user(at(2), "b".repeat(1000))]);
    const [only] = exchanges(rows, undefined);
    expect(only?.agent.length).toBeLessThanOrEqual(301);
    expect(only?.agent.endsWith("END")).toBe(true);
    expect(only?.user.length).toBeLessThanOrEqual(501);
  });
});

describe("listing a run", () => {
  test("prints the session id and every exchange since the last pass", () => {
    const { runDir, projectsDir } = fixture([started("A"), reviewed(at(4))], {
      A: [
        user(at(1), "before the pass"),
        agent(at(5), "Added the helper to src/utils."),
        user(at(6), "helpers go in src/lib"),
      ],
    });
    const listed = listRun({ runDir, projectsDir });
    expect(listed.ok).toBe(true);
    const text = listed.ok ? listed.value : "";
    expect(text).toContain(`since ${at(4)}`);
    expect(text).toContain("session A");
    expect(text).toContain("helpers go in src/lib");
    expect(text).toContain("Added the helper to src/utils.");
    expect(text).not.toContain("before the pass");
  });

  test("reads every session the run used, such as one a context step started", () => {
    const replaced = event("workflow.session.replaced", at(3), {
      agent: "claude",
      previousSessionId: "A",
      sessionId: "B",
    });
    const { runDir, projectsDir } = fixture([started("A"), replaced], {
      A: [user(at(1), "first session correction")],
      B: [user(at(4), "second session correction")],
    });
    const listed = listRun({ runDir, projectsDir });
    const text = listed.ok ? listed.value : "";
    expect(text).toContain("session A");
    expect(text).toContain("first session correction");
    expect(text).toContain("session B");
    expect(text).toContain("second session correction");
  });

  test("says so when nothing new was said", () => {
    const { runDir, projectsDir } = fixture([started("A"), reviewed(at(9))], {
      A: [user(at(1), "old")],
    });
    const listed = listRun({ runDir, projectsDir });
    expect(listed.ok && listed.value).toContain("nothing new");
  });

  test("fails without an event log", () => {
    const listed = listRun({ runDir: "/nonexistent", projectsDir: "/nonexistent" });
    expect(listed.ok).toBe(false);
  });
});

describe("listing one session outside a run", () => {
  test("prints every exchange of that session", () => {
    const { projectsDir } = fixture([], { S: [user(at(1), "use pnpm here")] });
    const listed = listSession({ sessionId: "S", projectsDir });
    expect(listed.ok && listed.value).toContain("use pnpm here");
  });

  test("fails when the transcript is missing", () => {
    const { projectsDir } = fixture([], {});
    expect(listSession({ sessionId: "missing", projectsDir }).ok).toBe(false);
  });
});
