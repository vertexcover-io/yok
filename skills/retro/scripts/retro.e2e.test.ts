import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Event, EventSchema, runDirOf } from "@yok/sdk";
import { seedEvents, seedRuns } from "../../../packages/cli/src/test-runs.ts";

const SCRIPT = join(import.meta.dir, "retro.ts");

type Row = Readonly<Record<string, unknown>>;

const jsonl = (rows: readonly Row[]): string => rows.map((row) => JSON.stringify(row)).join("\n");

const user = (ts: string, text: string): Row => ({
  type: "user",
  timestamp: ts,
  message: { role: "user", content: text },
});

const event = (seq: number, type: string, ts: string, payload: Row, nodeId?: string): Event =>
  EventSchema.parse({
    schemaVersion: 1,
    seq,
    id: `e-${seq}`,
    ts,
    type,
    source: "workflow",
    runId: "r-1",
    ...(nodeId ? { nodeId, nodeRunId: `nr-${nodeId}` } : {}),
    payload,
  });

// A checkout whose run run-x, in a yok home of its own, recorded one Claude session, and a
// projects folder holding that session's transcript, as `yok run` and Claude Code leave them.
// The checkout's real path, since git reports /private/var where mkdtemp gives /var on macOS.
const runFixture = async (): Promise<
  Readonly<{ cwd: string; home: string; projects: string; transcript: string }>
> => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "retro-e2e-")));
  execFileSync("git", ["init", "-q"], { cwd });
  mkdirSync(runDirOf(cwd, "run-x"), { recursive: true });
  const home = realpathSync(mkdtempSync(join(tmpdir(), "retro-e2e-home-")));
  await seedRuns(home, [
    {
      id: "r-1",
      project: "repo",
      workflow: "task",
      workflowPath: join(cwd, "task.yaml"),
      inputs: {},
      cwd,
      sessions: [],
      name: "run-x",
      terminal: null,
      config: null,
      tiers: null,
      createdAt: "2026-10-03T10:00:00Z",
    },
  ]);
  await seedEvents(home, "r-1", [
    event(1, "workflow.started", "2026-10-03T10:00:00Z", {
      workflow: "task",
      inputs: {},
      activeSessions: [{ agent: "claude", sessionId: "S1" }],
    }),
    event(2, "workflow.node.started", "2026-10-03T10:01:00Z", {}, "planning"),
    event(3, "workflow.node.completed", "2026-10-03T10:30:00Z", {}, "planning"),
  ]);
  const projects = join(cwd, "projects");
  mkdirSync(join(projects, "-Users-x-repo"), { recursive: true });
  const transcript = join(projects, "-Users-x-repo", "S1.jsonl");
  writeFileSync(
    transcript,
    jsonl([user("2026-10-03T10:05:00Z", "looks good, go"), user("2026-10-03T10:40:00Z", "stop")]),
  );
  return { cwd, home, projects, transcript };
};

// A run id or yok home from the shell running the tests must never reach a real database.
const retro = (cwd: string, home: string, args: readonly string[]) =>
  spawnSync("bun", [SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, YOK_RUN_ID: undefined, YOK_HOME: home },
  });

describe("bun run retro", () => {
  test("SC417: extract --run reads run-x's stored events, writes the run file, the stage table and main-1's nine files, exits 0 and prints the summary", async () => {
    const { cwd, home, projects } = await runFixture();
    const out = join(cwd, "out");

    const run = retro(cwd, home, [
      "extract",
      "--run",
      "run-x",
      "--out",
      out,
      "--projects",
      projects,
      "--tz",
      "UTC",
    ]);

    expect(run.status, run.stderr).toBe(0);
    expect(existsSync(join(out, "00-run.txt"))).toBe(true);
    expect(existsSync(join(out, "09-stages.txt"))).toBe(true);
    for (const n of ["00-summary", "01-spine", "02-assistant", "03-tool-calls", "04-tool-errors"]) {
      expect(existsSync(join(out, "main-1", `${n}.txt`))).toBe(true);
    }
    for (const n of ["05-ask-user", "06-subagents", "07-timeline", "08-incidents"]) {
      expect(existsSync(join(out, "main-1", `${n}.txt`))).toBe(true);
    }
    expect(run.stdout).toContain("post-gate msgs   1");
    expect(readFileSync(join(out, "main-1", "01-spine.txt"), "utf8")).toContain(
      "POST-GATE main-1.jsonl:2",
    );
  });

  test("SC418: extract --run for a run yok does not know exits 1 with a message on stderr and writes nothing", async () => {
    const { cwd, home, projects } = await runFixture();
    const out = join(cwd, "out");

    const run = retro(cwd, home, [
      "extract",
      "--run",
      "missing",
      "--out",
      out,
      "--projects",
      projects,
    ]);

    expect(run.status).toBe(1);
    expect(run.stderr.length).toBeGreaterThan(0);
    expect(existsSync(out)).toBe(false);
  });

  test("cite TRANSCRIPT LINE prints the record headed with the transcript's name and line", async () => {
    const { cwd, home, transcript } = await runFixture();

    const run = retro(cwd, home, ["cite", transcript, "2", "--tz", "UTC"]);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("--- S1.jsonl:2 @ 10-03 10:40:00 [user]\nstop");
  });
});
