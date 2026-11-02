import { expect, test } from "bun:test";
import { renderRuns } from "@yok/server";

const run = (id: string, project: string | null) => ({
  id,
  name: null,
  workflow: "ok",
  folder: "repo",
  cwd: "/srv/repo",
  prompt: null,
  status: "completed" as const,
  steps: { done: 3, total: 3 },
  current: null,
  agent: null,
  tier: null,
  model: null,
  blocker: null,
  startedAt: "2026-10-29T10:00:00.000Z",
  completedAt: null,
  pr: null,
  policies: {},
  project,
});

const NO_FLAGS = { project: undefined, status: undefined };
const HINT = "Use --limit N or --all to see more";

test("SC5001: 2 of 3 runs on a terminal print 'Showing 2 of 3 runs', a PROJECT column showing demo and -, and the --limit hint last", () => {
  const lines = renderRuns(
    { runs: [run("r-2", "demo"), run("r-1", null)], total: 3 },
    NO_FLAGS,
    true,
  ).split("\n");

  expect(lines[0]).toBe("Showing 2 of 3 runs");
  expect(lines[1]?.split(/\s{2,}/)).toEqual([
    "ID",
    "NAME",
    "PROJECT",
    "WORKFLOW",
    "STATUS",
    "STEPS",
    "STARTED (UTC)",
  ]);
  expect(lines[2]?.split(/\s{2,}/)).toContain("demo");
  expect(lines[3]?.split(/\s{2,}/)).toEqual([
    "r-1",
    "-",
    "-",
    "ok",
    "completed",
    "3/3",
    "10-29 10:00",
  ]);
  expect(lines.at(-1)).toBe(HINT);
});

test("SC5002: 3 of 3 runs with --project demo print '3 demo runs' and no hint", () => {
  const runs = [run("r-3", "demo"), run("r-2", "demo"), run("r-1", "demo")];

  const text = renderRuns({ runs, total: 3 }, { project: "demo", status: undefined }, true);

  expect(text.split("\n")[0]).toBe("3 demo runs");
  expect(text).not.toContain(HINT);
});

test("SC5003: no runs says how to start one, and a filtered-empty list says nothing matched", () => {
  const empty = { runs: [], total: 0 };

  expect(renderRuns(empty, NO_FLAGS, true)).toBe("No runs yet. Start one with yok run");
  expect(renderRuns(empty, { project: undefined, status: "blocked" }, true)).toBe("No runs match");
});

test("SC5004: piped output is the header and two rows, with no count line and no hint", () => {
  const lines = renderRuns(
    { runs: [run("r-2", "demo"), run("r-1", null)], total: 3 },
    NO_FLAGS,
    false,
  ).split("\n");

  expect(lines).toHaveLength(3);
  expect(lines[0]).toStartWith("ID");
  expect(lines.join("\n")).not.toContain("Showing");
  expect(lines.join("\n")).not.toContain(HINT);
});
