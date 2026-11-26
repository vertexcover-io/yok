import { describe, expect, test } from "bun:test";
import {
  type AuditMetric,
  type AuditResult,
  type AuditRun,
  type AuditStart,
  TEST_AUDIT_METRICS,
  TEST_AUDIT_PROBLEM_TYPES,
} from "./audits.ts";
import type { State } from "./contracts.ts";
import type { IStorage } from "./repositories.ts";
import { memoryStorage } from "./storage.ts";

const AT = "2026-11-01T00:00:00.000Z";

const runState = (runId: string, runName: string): State => ({
  schemaVersion: 1,
  lastEventSeq: 0,
  runId,
  runName,
  runDir: `/abs/web/.yok/${runName}`,
  version: "1",
  workflow: { name: "test-audit", path: "workflow.yaml" },
  input: {},
  scope: null,
  startedAt: AT,
  completedAt: null,
  status: "running",
  workspace: {
    type: "mono",
    path: "/abs/web",
    repositories: {
      web: { path: "/abs/web", git: { branch: "b", baseBranch: "main", startSha: "s" } },
    },
  },
  nodeRuns: {},
  activeSessions: [],
  tiers: null,
  eventHandlers: {},
  subscribers: {},
});

const addRun = async (storage: IStorage, id: string, name: string): Promise<void> => {
  await storage.runs.addRun({
    id,
    project: "web",
    workflow: "test-audit",
    workflowPath: "/abs/web/workflow.yaml",
    inputs: {},
    sessions: [],
    name: null,
    terminal: null,
    config: null,
    tiers: null,
    createdAt: AT,
  });
  const named = await storage.runs.initRun(id, name, runState(id, name));
  if (!named.ok) throw new Error(named.error);
};

// Project web with runs r-1 (weekly-test) and r-2 (weekly-test-2); more runs when named.
const seeded = async (extra: readonly string[] = []): Promise<IStorage> => {
  const storage = memoryStorage();
  const added = await storage.projects.add("web", {
    path: "/abs/web",
    addedBy: { channel: "cli" },
    addedAt: AT,
  });
  if (!added.ok) throw new Error(added.error);
  await addRun(storage, "r-1", "weekly-test");
  await addRun(storage, "r-2", "weekly-test-2");
  for (const id of extra) await addRun(storage, id, `weekly-${id}`);
  return storage;
};

const week = (runId: string, overrides: Partial<AuditStart> = {}): AuditStart => ({
  runId,
  project: "web",
  audit: "test",
  periodStart: "2026-11-01T00:00:00.000Z",
  periodEnd: "2026-11-08T00:00:00.000Z",
  commits: { web: "8c38b2c" },
  ...overrides,
});

const metric = (overrides: Partial<AuditMetric> = {}): AuditMetric => ({
  repo: "web",
  metric: "coverage",
  scope: "",
  status: "measured",
  reason: null,
  value: 81.5,
  how: { tool: "bun --coverage" },
  ...overrides,
});

const result = (auditRunId: string, slug: string, overrides: Partial<AuditResult> = {}) =>
  ({
    id: `${auditRunId}:web:duplicates:${slug}`,
    repo: "web",
    problemType: "duplicates",
    state: "needs_approval",
    title: `duplicate tests ${slug}`,
    proof: { files: ["a.test.ts", "b.test.ts"] },
    fix: null,
    ...overrides,
  }) satisfies AuditResult;

const startOk = async (storage: IStorage, start: AuditStart): Promise<AuditRun> => {
  const started = await storage.audits.start(start);
  if (!started.ok) throw new Error(started.error);
  return started.value;
};

describe("test-audit names", () => {
  test("SC7208: every known test-audit metric names a direction and a limit within its unit", () => {
    expect(Object.keys(TEST_AUDIT_METRICS)).toEqual([
      "coverage",
      "coverageChanged",
      "testCount",
      "testTime",
      "flakyTests",
      "duplicates",
      "duplicatesPct",
    ]);
    for (const info of Object.values(TEST_AUDIT_METRICS)) {
      expect(["higher", "lower"]).toContain(info.better);
      if (info.limit === null) continue;
      expect(info.limit).toBeGreaterThanOrEqual(0);
      if (info.unit === "percent") expect(info.limit).toBeLessThanOrEqual(100);
    }
    expect([...TEST_AUDIT_PROBLEM_TYPES]).toEqual(["duplicates", "flaky", "slow"]);
  });
});

describe("storage.audits", () => {
  test("SC7201: a started then finished audit reads back with its metrics and results", async () => {
    const storage = await seeded();

    const started = await startOk(storage, week("r-1"));
    expect(started.status).toBe("running");
    expect(started.id).toMatch(/^a-[0-9a-f]{8}$/);

    const metrics = [metric(), metric({ scope: "unit", value: 90 })];
    const results = [
      result(started.id, "one", {
        fix: { summary: "merge the two tests", diff: "--- a\n+++ b", commit: "abc123" },
      }),
      result(started.id, "two"),
    ];
    const finished = await storage.audits.finish(started.id, {
      status: "complete",
      metrics,
      results,
    });
    expect(finished).toEqual({ ok: true, value: { ...started, status: "complete" } });

    expect(await storage.audits.read(started.id)).toEqual({
      run: { ...started, status: "complete" },
      metrics,
      results,
    });
  });

  test("SC7202: a retried finish by the same run leaves exactly the rows it last listed", async () => {
    const storage = await seeded();
    const first = await startOk(storage, week("r-1"));
    await storage.audits.finish(first.id, {
      status: "complete",
      metrics: [metric(), metric({ scope: "unit" })],
      results: [result(first.id, "one"), result(first.id, "two")],
    });

    const again = await startOk(storage, week("r-1"));
    expect(again.id).toBe(first.id);
    expect(again.status).toBe("running");
    const kept = result(first.id, "two", { title: "renamed" });
    await storage.audits.finish(first.id, {
      status: "partial",
      metrics: [metric({ scope: "unit", value: 42 })],
      results: [kept],
    });

    const record = await storage.audits.read(first.id);
    expect(record?.run.status).toBe("partial");
    expect(record?.metrics).toEqual([metric({ scope: "unit", value: 42 })]);
    expect(record?.results).toEqual([kept]);
  });

  test("SC7203: another run starting a held period is refused with the holder's name", async () => {
    const storage = await seeded();
    const held = await startOk(storage, week("r-1"));

    const refused = await storage.audits.start(
      week("r-2", {
        periodStart: "2026-11-01T00:00:00Z",
        periodEnd: "2026-11-08T00:00:00Z",
      }),
    );

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toContain("held by run weekly-test");
    expect(await storage.audits.list("web", "test")).toEqual([held]);
    const qa = await storage.audits.start(week("r-2", { audit: "qa" }));
    expect(qa.ok).toBe(true);
  });

  test("SC7204: a finish with a result id outside its audit run, or for an unknown audit run, writes nothing", async () => {
    const storage = await seeded();
    const started = await startOk(storage, week("r-1"));
    const badId = "a-00000000:web:duplicates:one";

    const refused = await storage.audits.finish(started.id, {
      status: "complete",
      metrics: [metric()],
      results: [result(started.id, "ok"), { ...result(started.id, "bad"), id: badId }],
    });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toContain(badId);
    expect(await storage.audits.read(started.id)).toEqual({
      run: started,
      metrics: [],
      results: [],
    });
    expect(
      await storage.audits.finish("a-missing", { status: "complete", metrics: [], results: [] }),
    ).toEqual({ ok: false, error: "audit run a-missing not found" });
  });

  test("SC7205: unknown metric and problem-type names are stored", async () => {
    const storage = await seeded();
    const started = await startOk(storage, week("r-1"));
    const orphan = result(started.id, "x", {
      id: `${started.id}:web:orphan:x`,
      problemType: "orphan",
    });

    await storage.audits.finish(started.id, {
      status: "complete",
      metrics: [metric({ metric: "mutationScore" })],
      results: [orphan],
    });

    const record = await storage.audits.read(started.id);
    expect(record?.metrics.map((row) => row.metric)).toEqual(["mutationScore"]);
    expect(record?.results.map((row) => row.problemType)).toEqual(["orphan"]);
  });

  test("SC7206: a project's audits list newest period first, with a limit and a period filter", async () => {
    const storage = await seeded(["r-3", "r-4"]);
    const weeks = [
      ["2026-11-01T00:00:00.000Z", "2026-11-08T00:00:00.000Z"],
      ["2026-11-08T00:00:00.000Z", "2026-11-15T00:00:00.000Z"],
      ["2026-11-15T00:00:00.000Z", "2026-11-22T00:00:00.000Z"],
    ] as const;
    const [first, second, third] = [
      await startOk(storage, week("r-1", { periodStart: weeks[0][0], periodEnd: weeks[0][1] })),
      await startOk(storage, week("r-2", { periodStart: weeks[1][0], periodEnd: weeks[1][1] })),
      await startOk(storage, week("r-3", { periodStart: weeks[2][0], periodEnd: weeks[2][1] })),
    ];
    await startOk(
      storage,
      week("r-4", { audit: "qa", periodStart: weeks[1][0], periodEnd: weeks[1][1] }),
    );

    expect(await storage.audits.list("web", "test")).toEqual([third, second, first]);
    expect(await storage.audits.list("web", "test", { limit: 2 })).toEqual([third, second]);
    expect(
      await storage.audits.list("web", "test", {
        from: "2026-11-07T00:00:00Z",
        to: "2026-11-16T00:00:00Z",
      }),
    ).toEqual([second]);
  });

  test("SC7207: audit rows need their run and project, and leave with their run", async () => {
    const storage = await seeded();

    await expect(storage.audits.start(week("r-missing"))).rejects.toThrow("FOREIGN KEY");
    await expect(storage.audits.start(week("r-2", { project: "gone" }))).rejects.toThrow(
      "FOREIGN KEY",
    );

    const started = await startOk(storage, week("r-1"));
    await storage.audits.finish(started.id, {
      status: "complete",
      metrics: [metric()],
      results: [result(started.id, "one")],
    });
    await storage.runs.removeRun("r-1");

    expect(await storage.audits.read(started.id)).toBeUndefined();
    expect(await storage.audits.list("web", "test")).toEqual([]);
  });
});

describe("storage.audits result events", () => {
  // Run r-1's finished test audit, with results AUDIT:web:duplicates:one and :two.
  const finished = async () => {
    const storage = await seeded();
    const run = await startOk(storage, week("r-1"));
    const [one, two] = [result(run.id, "one"), result(run.id, "two")];
    await storage.audits.finish(run.id, { status: "complete", metrics: [], results: [one, two] });
    return { storage, run, one, two };
  };

  test("SC7211: a result's decision is its newest click", async () => {
    const { storage, one, two } = await finished();
    const clicks = [
      {
        resultId: one.id,
        type: "accepted",
        who: "savitha",
        startedRunId: "r-2",
        payload: { feedback: "merge them" },
      },
      { resultId: one.id, type: "rejected", who: "ritesh", startedRunId: null, payload: {} },
      { resultId: one.id, type: "undone", who: "savitha", startedRunId: null, payload: {} },
    ] as const;

    for (const click of clicks) {
      const event = await storage.audits.addEvent(click);
      expect(event).toEqual({
        ...click,
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        ts: expect.any(String),
      });
      expect(new Date(event.ts).toISOString()).toBe(event.ts);
      expect(await storage.audits.decision(one.id)).toEqual(event);
    }
    expect(await storage.audits.decision(two.id)).toBeUndefined();
  });

  test("SC7212: a retried finish keeps a clicked result it no longer lists, and drops an unclicked one", async () => {
    const { storage, run, one } = await finished();
    const accepted = await storage.audits.addEvent({
      resultId: one.id,
      type: "accepted",
      who: "savitha",
      startedRunId: null,
      payload: {},
    });

    await startOk(storage, week("r-1"));
    await storage.audits.finish(run.id, { status: "complete", metrics: [], results: [] });

    expect((await storage.audits.read(run.id))?.results).toEqual([one]);
    expect(await storage.audits.decision(one.id)).toEqual(accepted);
  });

  test("SC7213: a retried finish that lists a clicked result updates it and keeps its clicks", async () => {
    const { storage, run, one } = await finished();
    const accepted = await storage.audits.addEvent({
      resultId: one.id,
      type: "accepted",
      who: "savitha",
      startedRunId: null,
      payload: {},
    });
    const updated = { ...one, title: "merged duplicate tests", state: "auto_fixed" as const };

    await storage.audits.finish(run.id, { status: "complete", metrics: [], results: [updated] });

    expect((await storage.audits.read(run.id))?.results).toEqual([updated]);
    expect(await storage.audits.decision(one.id)).toEqual(accepted);
  });

  test("SC7214: a click needs its result and its started run", async () => {
    const { storage, one } = await finished();
    const click = { type: "accepted", who: "savitha", payload: {} } as const;

    await expect(
      storage.audits.addEvent({ ...click, resultId: "nope", startedRunId: null }),
    ).rejects.toThrow("FOREIGN KEY");
    await expect(
      storage.audits.addEvent({ ...click, resultId: one.id, startedRunId: "r-missing" }),
    ).rejects.toThrow("FOREIGN KEY");
    expect(await storage.audits.decision(one.id)).toBeUndefined();
  });

  test("SC7215: removing the started run keeps the click; removing the audit's run removes the results and their clicks", async () => {
    const { storage, run, one } = await finished();
    const accepted = await storage.audits.addEvent({
      resultId: one.id,
      type: "accepted",
      who: "savitha",
      startedRunId: "r-2",
      payload: {},
    });

    await storage.runs.removeRun("r-2");
    expect(await storage.audits.decision(one.id)).toEqual({ ...accepted, startedRunId: null });

    await storage.runs.removeRun("r-1");
    expect(await storage.audits.decision(one.id)).toBeUndefined();
    expect(await storage.audits.read(run.id)).toBeUndefined();
  });
});
