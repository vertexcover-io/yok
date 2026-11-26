import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import {
  type AUDIT_CLICK_TYPES,
  type AUDIT_RUN_START_TYPES,
  type AuditFixPatch,
  type AuditMetric,
  type AuditReport,
  type AuditResult,
  type AuditResultEventDraft,
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

const addRun = async (
  storage: IStorage,
  id: string,
  name: string,
  project = "web",
): Promise<void> => {
  await storage.runs.addRun({
    id,
    project,
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
    expect([...TEST_AUDIT_PROBLEM_TYPES]).toEqual(["duplicates", "flaky", "slow", "failing"]);
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

  test("SC7216: a finish that repeats a result id or a metric's repo, metric and scope is refused, names the repeat and writes nothing", async () => {
    const storage = await seeded();
    const started = await startOk(storage, week("r-1"));
    const twice = result(started.id, "twice");

    const repeatedResult = await storage.audits.finish(started.id, {
      status: "complete",
      metrics: [metric()],
      results: [twice, { ...twice, title: "another finding, same slug" }],
    });
    const repeatedMetric = await storage.audits.finish(started.id, {
      status: "complete",
      metrics: [metric(), metric({ value: 90 }), metric({ scope: "unit" })],
      results: [result(started.id, "one")],
    });

    expect(repeatedResult).toEqual({ ok: false, error: `repeated result ids: ${twice.id}` });
    expect(repeatedMetric).toEqual({ ok: false, error: 'repeated metrics: ["web","coverage",""]' });
    expect(await storage.audits.read(started.id)).toEqual({
      run: started,
      metrics: [],
      results: [],
    });
  });

  test("SC7205: a finish naming an unknown metric or problem type is refused and writes nothing", async () => {
    const storage = await seeded();
    const started = await startOk(storage, week("r-1"));
    const report = {
      status: "complete",
      metrics: [metric()],
      results: [result(started.id, "ok")],
    } as const;

    await expect(
      storage.audits.finish(started.id, {
        ...report,
        metrics: [{ ...metric(), metric: "mutationScore" }],
      } as unknown as AuditReport),
    ).rejects.toThrow("metric");
    await expect(
      storage.audits.finish(started.id, {
        ...report,
        results: [{ ...result(started.id, "x"), problemType: "orphan" }],
      } as unknown as AuditReport),
    ).rejects.toThrow("problemType");
    expect(await storage.audits.read(started.id)).toEqual({
      run: started,
      metrics: [],
      results: [],
    });
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
    // Bounds exactly on the second week, spelled unlike the stored "…00.000Z": with the
    // -05:00 offset, a string compare without normalizing would put "to" before the week's end.
    expect(
      await storage.audits.list("web", "test", {
        from: "2026-11-08T00:00:00Z",
        to: "2026-11-14T19:00:00-05:00",
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
        startedRunId: null,
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

  test("SC7214: an event needs its result, and a run start needs its run", async () => {
    const { storage, one } = await finished();

    await expect(
      storage.audits.addEvent({
        resultId: "nope",
        type: "accepted",
        who: "savitha",
        startedRunId: null,
        payload: {},
      }),
    ).rejects.toThrow("FOREIGN KEY");
    await expect(
      storage.audits.addEvent({
        resultId: one.id,
        type: "apply_started",
        who: "yok",
        startedRunId: "r-missing",
        payload: {},
      }),
    ).rejects.toThrow("FOREIGN KEY");
    expect(await storage.audits.decision(one.id)).toBeUndefined();
    expect(await storage.audits.run(one.id)).toBeUndefined();
  });

  test("SC7215: removing the started run keeps its run start; removing the audit's run removes the results and their events", async () => {
    const { storage, run, one } = await finished();
    const started = await storage.audits.addEvent({
      resultId: one.id,
      type: "apply_started",
      who: "yok",
      startedRunId: "r-2",
      payload: {},
    });

    await storage.runs.removeRun("r-2");
    expect(await storage.audits.run(one.id)).toEqual({ ...started, startedRunId: null });

    await storage.runs.removeRun("r-1");
    expect(await storage.audits.run(one.id)).toBeUndefined();
    expect(await storage.audits.read(run.id)).toBeUndefined();
  });

  test("SC7217: the decision stays the person's click after yok starts a run, and run returns yok's row", async () => {
    const { storage, one } = await finished();
    expect(await storage.audits.run(one.id)).toBeUndefined();

    const accepted = await storage.audits.addEvent({
      resultId: one.id,
      type: "accepted",
      who: "savitha",
      startedRunId: null,
      payload: {},
    });
    const applyStarted = await storage.audits.addEvent({
      resultId: one.id,
      type: "apply_started",
      who: "yok",
      startedRunId: "r-2",
      payload: {},
    });
    expect(await storage.audits.decision(one.id)).toEqual(accepted);
    expect(await storage.audits.run(one.id)).toEqual(applyStarted);
    expect(applyStarted.startedRunId).toBe("r-2");

    const undone = await storage.audits.addEvent({
      resultId: one.id,
      type: "undone",
      who: "savitha",
      startedRunId: null,
      payload: {},
    });
    const revertStarted = await storage.audits.addEvent({
      resultId: one.id,
      type: "revert_started",
      who: "yok",
      startedRunId: "r-2",
      payload: {},
    });
    expect(await storage.audits.decision(one.id)).toEqual(undone);
    expect(await storage.audits.run(one.id)).toEqual(revertStarted);
  });

  test("SC7218: a click that names a run, or a run start that names none, is refused", async () => {
    const { storage, one } = await finished();

    await expect(
      storage.audits.addEvent({
        resultId: one.id,
        type: "accepted",
        who: "savitha",
        startedRunId: "r-2",
        payload: {},
      } as unknown as AuditResultEventDraft),
    ).rejects.toThrow();
    await expect(
      storage.audits.addEvent({
        resultId: one.id,
        type: "apply_started",
        who: "yok",
        startedRunId: null,
        payload: {},
      } as unknown as AuditResultEventDraft),
    ).rejects.toThrow();
    expect(await storage.audits.decision(one.id)).toBeUndefined();
    expect(await storage.audits.run(one.id)).toBeUndefined();
  });
});

describe("storage.audits fixes", () => {
  const instruction = { summary: "merge the two tests", diff: "--- a\n+++ b" };

  // Run r-1's finished test audit: result one has a fix, result two has none.
  const finished = async (fix: AuditResult["fix"] = instruction) => {
    const storage = await seeded();
    const run = await startOk(storage, week("r-1"));
    const [one, two] = [result(run.id, "one", { fix }), result(run.id, "two")];
    await storage.audits.finish(run.id, { status: "complete", metrics: [], results: [one, two] });
    return { storage, run, one, two };
  };

  const fixOf = async (storage: IStorage, auditRunId: string, resultId: string) =>
    (await storage.audits.read(auditRunId))?.results.find((row) => row.id === resultId)?.fix;

  afterEach(() => {
    setSystemTime();
  });

  test("SC7219: writing a commit and PR keeps the instruction and stamps the time", async () => {
    const { storage, run, one } = await finished();
    setSystemTime(new Date("2026-11-02T10:00:00.000Z"));

    const reply = await storage.audits.setFix(one.id, {
      commit: "abc123",
      pr: "https://github.com/o/web/pull/7",
    });

    const fix = {
      ...instruction,
      commit: "abc123",
      pr: "https://github.com/o/web/pull/7",
      at: "2026-11-02T10:00:00.000Z",
    };
    expect(reply).toEqual({ ok: true, value: { ...one, fix } });
    expect(await fixOf(storage, run.id, one.id)).toEqual(fix);
  });

  test("SC7220: a commit replaces an earlier error, while an error keeps the commit", async () => {
    const { storage, run, one } = await finished();

    await storage.audits.setFix(one.id, { error: "merge conflict" });
    await storage.audits.setFix(one.id, { commit: "abc123" });
    const applied = await fixOf(storage, run.id, one.id);
    expect(applied).toEqual({ ...instruction, commit: "abc123", at: expect.any(String) });
    expect(applied).not.toHaveProperty("error");

    await storage.audits.setFix(one.id, { error: "revert failed" });
    expect(await fixOf(storage, run.id, one.id)).toEqual({
      ...instruction,
      commit: "abc123",
      error: "revert failed",
      at: expect.any(String),
    });
  });

  test("a patch key set to undefined keeps the stored value, and a patch of only undefined keys is refused", async () => {
    const { storage, run, one } = await finished();
    await storage.audits.setFix(one.id, { commit: "abc123" });

    await storage.audits.setFix(one.id, { error: "revert failed", commit: undefined });
    const kept = {
      ...instruction,
      commit: "abc123",
      error: "revert failed",
      at: expect.any(String),
    };
    expect(await fixOf(storage, run.id, one.id)).toEqual(kept);

    await expect(
      storage.audits.setFix(one.id, { commit: undefined, pr: undefined, error: undefined }),
    ).rejects.toThrow("a fix patch sets commit, pr or error");
    expect(await fixOf(storage, run.id, one.id)).toEqual(kept);
  });

  test("SC7221: clearing removes everything the apply run wrote", async () => {
    const withPrompt = { ...instruction, prompt: "merge them" };
    const { storage, run, one } = await finished(withPrompt);
    await storage.audits.setFix(one.id, {
      commit: "abc123",
      pr: "https://github.com/o/web/pull/7",
    });
    await storage.audits.setFix(one.id, { error: "revert failed" });

    await storage.audits.setFix(one.id, { clear: true });

    expect(await fixOf(storage, run.id, one.id)).toEqual(withPrompt);
  });

  test("SC7222: a patch for an unknown result, a result with no fix, or with nothing to set is refused", async () => {
    const { storage, run, one, two } = await finished();

    expect(await storage.audits.setFix("nope", { commit: "c" })).toEqual({
      ok: false,
      error: "audit result nope not found",
    });
    expect(await storage.audits.setFix(two.id, { commit: "c" })).toEqual({
      ok: false,
      error: `audit result ${two.id} has no fix`,
    });
    expect(await fixOf(storage, run.id, two.id)).toBeNull();
    await expect(storage.audits.setFix(one.id, {})).rejects.toThrow(
      "a fix patch sets commit, pr or error",
    );
    expect(await fixOf(storage, run.id, one.id)).toEqual(instruction);
  });
});

describe("storage.audits pending work", () => {
  const instruction = { summary: "merge the two tests", diff: "--- a\n+++ b" };
  let seconds = 0;

  // One second per action, so clicks and setFix writes never share a time.
  const tick = (): void => {
    seconds += 1;
    setSystemTime(new Date(Date.parse(AT) + seconds * 1000));
  };

  afterEach(() => {
    seconds = 0;
    setSystemTime();
  });

  // Run r-1's finished test audit: results one and two have a fix, three has none.
  const finished = async () => {
    const storage = await seeded();
    const run = await startOk(storage, week("r-1"));
    const [one, two, three] = [
      result(run.id, "one", { fix: instruction }),
      result(run.id, "two", { fix: instruction }),
      result(run.id, "three"),
    ];
    await storage.audits.finish(run.id, {
      status: "complete",
      metrics: [],
      results: [one, two, three],
    });
    return { storage, run, one, two, three };
  };

  const click = async (
    storage: IStorage,
    resultId: string,
    type: (typeof AUDIT_CLICK_TYPES)[number],
  ) => {
    tick();
    return storage.audits.addEvent({
      resultId,
      type,
      who: "savitha",
      startedRunId: null,
      payload: {},
    });
  };

  const startRun = async (
    storage: IStorage,
    resultId: string,
    type: (typeof AUDIT_RUN_START_TYPES)[number],
  ) => {
    tick();
    return storage.audits.addEvent({
      resultId,
      type,
      who: "yok",
      startedRunId: "r-2",
      payload: {},
    });
  };

  const setFix = async (storage: IStorage, resultId: string, patch: AuditFixPatch) => {
    tick();
    const reply = await storage.audits.setFix(resultId, patch);
    if (!reply.ok) throw new Error(reply.error);
  };

  const pending = async (storage: IStorage, project = "web") =>
    (await storage.audits.pendingWork(project)).map((work) => ({
      auditRunId: work.auditRunId,
      resultId: work.result.id,
      eventId: work.event.id,
      action: work.action,
    }));

  test("SC7223: an accepted fix no run has taken is pending apply, until yok starts one", async () => {
    const { storage, run, one, two } = await finished();
    const added = await storage.projects.add("api", {
      path: "/abs/api",
      addedBy: { channel: "cli" },
      addedAt: AT,
    });
    if (!added.ok) throw new Error(added.error);
    await addRun(storage, "r-3", "weekly-api", "api");
    const apiRun = await startOk(storage, week("r-3", { project: "api" }));
    const apiResult = result(apiRun.id, "api", { fix: instruction });
    await storage.audits.finish(apiRun.id, {
      status: "complete",
      metrics: [],
      results: [apiResult],
    });

    const accepted = await click(storage, one.id, "accepted");
    await click(storage, two.id, "rejected");
    const apiAccepted = await click(storage, apiResult.id, "accepted");

    expect(await storage.audits.pendingWork("web")).toEqual([
      { auditRunId: run.id, result: one, event: accepted, action: "apply" },
    ]);
    expect(await pending(storage, "api")).toEqual([
      { auditRunId: apiRun.id, resultId: apiResult.id, eventId: apiAccepted.id, action: "apply" },
    ]);

    await startRun(storage, one.id, "apply_started");
    expect(await storage.audits.pendingWork("web")).toEqual([]);
  });

  test("SC7224: a commit or an error ends the pending apply, and a new accept after a failure retries", async () => {
    const { storage, run, one } = await finished();
    await click(storage, one.id, "accepted");
    await startRun(storage, one.id, "apply_started");
    await setFix(storage, one.id, { error: "conflict" });
    expect(await pending(storage)).toEqual([]);

    const again = await click(storage, one.id, "accepted");
    expect(await pending(storage)).toEqual([
      { auditRunId: run.id, resultId: one.id, eventId: again.id, action: "apply" },
    ]);

    await startRun(storage, one.id, "apply_started");
    await setFix(storage, one.id, { commit: "abc" });
    expect(await pending(storage)).toEqual([]);
  });

  test("SC7225: an undone applied fix is pending revert until yok starts the revert", async () => {
    const { storage, run, one } = await finished();
    await click(storage, one.id, "accepted");
    await startRun(storage, one.id, "apply_started");
    await setFix(storage, one.id, { commit: "abc", pr: "https://github.com/o/web/pull/7" });

    const undone = await click(storage, one.id, "undone");
    expect(await pending(storage)).toEqual([
      { auditRunId: run.id, resultId: one.id, eventId: undone.id, action: "revert" },
    ]);

    await startRun(storage, one.id, "revert_started");
    expect(await pending(storage)).toEqual([]);
    await setFix(storage, one.id, { clear: true });
    expect(await pending(storage)).toEqual([]);
  });

  test("SC7226: a failed revert waits for a new undo", async () => {
    const { storage, run, one } = await finished();
    await click(storage, one.id, "accepted");
    await startRun(storage, one.id, "apply_started");
    await setFix(storage, one.id, { commit: "abc" });
    await click(storage, one.id, "undone");
    await startRun(storage, one.id, "revert_started");
    await setFix(storage, one.id, { error: "revert conflict" });
    expect(await pending(storage)).toEqual([]);

    const again = await click(storage, one.id, "undone");
    expect(await pending(storage)).toEqual([
      { auditRunId: run.id, resultId: one.id, eventId: again.id, action: "revert" },
    ]);
  });

  test("SC7227: undo of a fix never applied, a result with no fix, and a run start of the other kind owe or block nothing", async () => {
    const { storage, run, one, two, three } = await finished();
    await click(storage, one.id, "accepted");
    await click(storage, one.id, "undone");
    await click(storage, three.id, "accepted");
    const accepted = await click(storage, two.id, "accepted");
    await startRun(storage, two.id, "revert_started");

    expect(await pending(storage)).toEqual([
      { auditRunId: run.id, resultId: two.id, eventId: accepted.id, action: "apply" },
    ]);
  });

  test("SC7228: pending work spans the project's audit runs and lists the oldest click first", async () => {
    const storage = await seeded();
    const first = await startOk(storage, week("r-1"));
    const second = await startOk(
      storage,
      week("r-2", {
        periodStart: "2026-11-08T00:00:00.000Z",
        periodEnd: "2026-11-15T00:00:00.000Z",
      }),
    );
    const [older, newer] = [
      result(first.id, "one", { fix: instruction }),
      result(second.id, "one", { fix: instruction }),
    ];
    await storage.audits.finish(first.id, { status: "complete", metrics: [], results: [older] });
    await storage.audits.finish(second.id, { status: "complete", metrics: [], results: [newer] });

    const newerAccepted = await click(storage, newer.id, "accepted");
    const olderAccepted = await click(storage, older.id, "accepted");

    expect(await pending(storage)).toEqual([
      { auditRunId: second.id, resultId: newer.id, eventId: newerAccepted.id, action: "apply" },
      { auditRunId: first.id, resultId: older.id, eventId: olderAccepted.id, action: "apply" },
    ]);
  });
});
