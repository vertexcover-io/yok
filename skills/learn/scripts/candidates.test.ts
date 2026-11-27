import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Event, EventSchema, type Rec, runDirOf } from "@yok/sdk";
import { withStorage } from "@yok/sdk/internal";
import { seedEvents } from "../../../packages/cli/src/test-runs.ts";
import { exchanges, lastReviewedAt, listRun, main } from "./candidates.ts";

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

// A repo with one run folder and the run's events, beside a fake ~/.claude/projects holding the
// given transcripts.
const fixture = (
  events: readonly Event[],
  transcripts: Readonly<Record<string, readonly Row[]>>,
): Readonly<{ runDir: string; events: readonly Event[]; projectsDir: string }> => {
  const base = mkdtempSync(join(tmpdir(), "learn-"));
  const runDir = runDirOf(base, "run-x");
  mkdirSync(runDir, { recursive: true });
  const projectsDir = join(base, "projects");
  const slug = join(projectsDir, "-Users-x-repo");
  mkdirSync(slug, { recursive: true });
  for (const [id, rows] of Object.entries(transcripts)) {
    writeFileSync(join(slug, `${id}.jsonl`), jsonl(rows));
  }
  return { runDir, events, projectsDir };
};

// The fixture's run and its events in a fresh yok home's yok.db, and $YOK_RUN_ID set to it.
const inRun = async (runDir: string, events: readonly Event[]): Promise<void> => {
  const home = mkdtempSync(join(tmpdir(), "learn-home-"));
  const cwd = join(runDir, "..", "..");
  await withStorage(home, async (storage) => {
    const project = { path: cwd, addedBy: { channel: "cli" }, addedAt: at(0) };
    const added = await storage.projects.add("repo", project);
    if (!added.ok) throw new Error(added.error);
    await storage.runs.addRun({
      id: "r-1",
      project: "repo",
      workflow: "task",
      workflowPath: join(cwd, "task.yaml"),
      inputs: {},
      sessions: [],
      name: "run-x",
      terminal: null,
      config: null,
      tiers: null,
      createdAt: at(0),
    });
  });
  await seedEvents(home, "r-1", events);
  process.env.YOK_HOME = home;
  process.env.YOK_RUN_ID = "r-1";
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
  test("SC405: prints session A and every exchange after the 10:04 pass, not the one before it", () => {
    const text = listRun(
      fixture([started("A"), reviewed(at(4))], {
        A: [
          user(at(1), "before the pass"),
          agent(at(5), "Added the helper to src/utils."),
          user(at(6), "helpers go in src/lib"),
        ],
      }),
    );
    expect(text).toContain(`since ${at(4)}`);
    expect(text).toContain("session A");
    expect(text).toContain("helpers go in src/lib");
    expect(text).toContain("Added the helper to src/utils.");
    expect(text).not.toContain("before the pass");
  });

  test("SC405: reads sessions A and B when a context step replaced A with B", () => {
    const replaced = event("workflow.session.replaced", at(3), {
      agent: "claude",
      previousSessionId: "A",
      sessionId: "B",
    });
    const text = listRun(
      fixture([started("A"), replaced], {
        A: [user(at(1), "first session correction")],
        B: [user(at(4), "second session correction")],
      }),
    );
    expect(text).toContain("session A");
    expect(text).toContain("first session correction");
    expect(text).toContain("session B");
    expect(text).toContain("second session correction");
  });

  test("SC405: says nothing new when the last pass came after the last message", () => {
    const text = listRun(fixture([started("A"), reviewed(at(9))], { A: [user(at(1), "old")] }));
    expect(text).toContain("nothing new");
  });
});

describe("choosing what to list", () => {
  const saved = { YOK_HOME: process.env.YOK_HOME, YOK_RUN_ID: process.env.YOK_RUN_ID };
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("SC414: in a run whose stored events hold a 10:04 pass, lists the 10:06 message and not the 10:01 one", async () => {
    const { runDir, events, projectsDir } = fixture([started("A"), reviewed(at(4))], {
      A: [user(at(1), "before the pass"), user(at(6), "after the pass")],
    });
    await inRun(runDir, events);
    const log = spyOn(console, "log").mockImplementation(() => {});
    const code = await main(["--projects", projectsDir]);
    const printed = log.mock.calls.flat().join("\n");
    log.mockRestore();
    expect(code).toBe(0);
    expect(printed).toContain("after the pass");
    expect(printed).not.toContain("before the pass");
  });

  test("outside a run, says learn needs one and fails", async () => {
    delete process.env.YOK_RUN_ID;
    const error = spyOn(console, "error").mockImplementation(() => {});
    const code = await main([]);
    const printed = error.mock.calls.flat().join("\n");
    error.mockRestore();
    expect(code).toBe(1);
    expect(printed).toContain("learn works only in a yok run");
  });
});
