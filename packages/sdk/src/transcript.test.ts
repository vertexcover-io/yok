import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Event, EventSchema } from "./contracts.ts";
import { answers, findTranscript, humanMessages, type Rec, readRunSessions } from "./transcript.ts";

const recs = (rows: readonly Record<string, unknown>[]): readonly Rec[] =>
  rows.map((data, i) => ({ line: i + 1, data }));

const at = (minute: number): string => `2026-10-03T10:${String(minute).padStart(2, "0")}:00Z`;

const user = (ts: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  type: "user",
  timestamp: ts,
  message: { role: "user", content },
  ...extra,
});

const queued = (ts: string, prompt: string) => ({
  type: "attachment",
  timestamp: ts,
  attachment: { type: "queued_command", origin: { kind: "human" }, prompt },
});

const enqueue = (ts: string, content: string) => ({
  type: "queue-operation",
  timestamp: ts,
  operation: "enqueue",
  content,
});

describe("humanMessages", () => {
  test("SC8: the user text, the queued attachment and a typed slash command are the messages in time order, a text found in both places is kept once as QUEUED, and notifications, sub-agent hand-backs and meta records are not messages", () => {
    const slashCommand =
      "<command-message>retro</command-message>\n<command-name>/retro</command-name>\n<command-args>--run demo</command-args>";
    const rows = humanMessages(
      recs([
        user(at(1), "fix the header"),
        enqueue(at(0), "fix the header"),
        queued(at(3), "use the blue token"),
        enqueue(at(2), "<task-notification>agent-1 finished</task-notification>"),
        enqueue(at(5), '<agent-message from="a1">phase 1 COMPLETED</agent-message>'),
        user(at(6), slashCommand),
        user(at(4), "injected context", { isMeta: true }),
      ]),
    );

    expect(rows.map((m) => [m.kind, m.text])).toEqual([
      ["QUEUED", "fix the header"],
      ["QUEUED", "use the blue token"],
      ["TYPED", slashCommand],
    ]);
    expect(rows.map((m) => m.line)).toEqual([2, 3, 6]);
  });
});

describe("answers", () => {
  test("pairs each AskUserQuestion with the answer that came back, with its time", () => {
    const rows = recs([
      {
        type: "assistant",
        timestamp: at(1),
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: {} }],
        },
      },
      user(at(2), [{ type: "tool_result", tool_use_id: "q1", content: '"Approve?"="Revise"' }]),
    ]);

    expect(answers(rows).map((a) => [a.call?.name, a.ts, a.text])).toEqual([
      ["AskUserQuestion", at(2), '"Approve?"="Revise"'],
    ]);
  });
});

const event = (type: string, ts: string, payload: Record<string, unknown>): Event =>
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

describe("readRunSessions", () => {
  test("lists the sessions from workflow.started and later events in first-seen order, once each", () => {
    const events = [
      event("workflow.started", at(0), {
        workflow: "task",
        inputs: {},
        activeSessions: [{ agent: "claude", sessionId: "A" }],
      }),
      event("hooks.stop.called", at(1), { agent: "claude", sessionId: "A", decision: "allow" }),
      event("hooks.stop.called", at(2), { agent: "codex", sessionId: "B", decision: "allow" }),
    ];

    expect(readRunSessions(events)).toEqual([
      { agent: "claude", sessionId: "A" },
      { agent: "codex", sessionId: "B" },
    ]);
  });
});

describe("findTranscript", () => {
  test("finds a session's transcript in whichever project folder holds it", () => {
    const projects = mkdtempSync(join(tmpdir(), "transcript-"));
    mkdirSync(join(projects, "-Users-x-repo"));
    writeFileSync(join(projects, "-Users-x-repo", "S.jsonl"), "");

    expect(findTranscript(projects, "S")).toBe(join(projects, "-Users-x-repo", "S.jsonl"));
    expect(findTranscript(projects, "missing")).toBeUndefined();
  });
});
