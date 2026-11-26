import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IStorage, JsonObject, State } from "@yok/sdk";
import { createGit, noopLogger } from "@yok/sdk";
import { type AuditResult, type AuditRun, memoryStorage } from "@yok/sdk/internal";
import { createApi } from "./app.ts";
import { fakeHost, fakeProvider, seedState } from "./fake-host.ts";

const AT = "2026-11-01T00:00:00.000Z";

const buildDeps = (storage: IStorage = memoryStorage()) => ({
  storage,
  providerFor: () => fakeProvider("claude", () => Promise.resolve({ ok: false, error: "unused" })),
  host: fakeHost("", false).host,
  log: noopLogger,
  home: mkdtempSync(join(tmpdir(), "yok-home-")),
  publicOrigin: "http://localhost:1",
  pid: 4242,
  version: "0.0.0-test",
  startedAt: 1_700_000_000_000,
  stopping: new AbortController().signal,
  git: createGit(),
  checkCheckout: () => Promise.reject(new Error("unused")),
});

const addProject = async (storage: IStorage, name: string): Promise<void> => {
  const added = await storage.projects.add(name, {
    path: `/abs/${name}`,
    addedBy: { channel: "cli" },
    addedAt: AT,
  });
  if (!added.ok) throw new Error(added.error);
};

type SeedRun = Readonly<{
  project?: string;
  workflow?: string;
  inputs?: JsonObject;
  state?: Partial<State>;
}>;

// Stores run ID in PROJECT, named by init with a state, as a started run is.
const addRun = async (storage: IStorage, id: string, seed: SeedRun = {}): Promise<void> => {
  const project = seed.project ?? "web";
  await storage.runs.addRun({
    id,
    project,
    workflow: seed.workflow ?? "test-audit",
    workflowPath: `/abs/${project}/workflow.yaml`,
    inputs: seed.inputs ?? {},
    sessions: [],
    name: null,
    terminal: null,
    config: null,
    tiers: null,
    createdAt: AT,
  });
  const state = { ...seedState(`/abs/${project}/.yok/${id}`, {}), runId: id, ...seed.state };
  const named = await storage.runs.initRun(id, `run-${id}`, state);
  if (!named.ok) throw new Error(named.error);
};

const weekEnding = (day: number) => ({
  periodStart: new Date(Date.UTC(2026, 10, day - 7)).toISOString(),
  periodEnd: new Date(Date.UTC(2026, 10, day)).toISOString(),
});

const result = (auditRunId: string, slug: string): AuditResult => ({
  id: `${auditRunId}:web:duplicates:${slug}`,
  repo: "web",
  problemType: "duplicates",
  state: "needs_approval",
  title: `duplicate tests ${slug}`,
  proof: {},
  fix: { summary: "delete the copy", diff: "-a" },
});

const coverage = (repo: string, value: number) => ({
  repo,
  metric: "coverage" as const,
  scope: "",
  status: "measured" as const,
  reason: null,
  value,
  how: {},
});

type SeedAudit = Readonly<{
  runId: string;
  project?: string;
  day?: number;
  slugs?: readonly string[];
  values?: Readonly<Record<string, number>>;
}>;

// A finished test audit of the run, for the week ending on November DAY.
const addAudit = async (storage: IStorage, seed: SeedAudit): Promise<AuditRun> => {
  const started = await storage.audits.start({
    runId: seed.runId,
    project: seed.project ?? "web",
    audit: "test",
    ...weekEnding(seed.day ?? 8),
    commits: { web: "8c38b2c" },
  });
  if (!started.ok) throw new Error(started.error);
  const id = started.value.id;
  const finished = await storage.audits.finish(id, {
    status: "complete",
    metrics: Object.entries(seed.values ?? {}).map(([repo, value]) => coverage(repo, value)),
    results: (seed.slugs ?? []).map((slug) => result(id, slug)),
  });
  if (!finished.ok) throw new Error(finished.error);
  return finished.value;
};

const getJson = async (app: ReturnType<typeof createApi>, path: string) => {
  const response = await app.request(path);
  return { status: response.status, body: await response.json() };
};

// Project web with three weekly audits ending November 8, 15 and 22.
const threeWeeks = async () => {
  const storage = memoryStorage();
  await addProject(storage, "web");
  const audits = [];
  for (const [index, day] of [8, 15, 22].entries()) {
    await addRun(storage, `r-${index}`);
    audits.push(
      await addAudit(storage, { runId: `r-${index}`, day, values: { web: day, api: day + 1 } }),
    );
  }
  return { storage, audits };
};

describe("GET /audits", () => {
  test("SC7301: the projects route names only projects with a test audit run", async () => {
    const storage = memoryStorage();
    await addProject(storage, "web");
    await addProject(storage, "api");
    await addRun(storage, "r-1");
    await addAudit(storage, { runId: "r-1" });
    const app = createApi(buildDeps(storage));

    const reply = await getJson(app, "/audits/projects?audit=test");

    expect(reply).toEqual({ status: 200, body: { projects: ["web"] } });
  });

  test("SC7302: the run picker gives the newest N audit runs, newest period first", async () => {
    const { storage, audits } = await threeWeeks();
    const app = createApi(buildDeps(storage));

    const two = await getJson(app, "/audits?project=web&audit=test&limit=2");
    const all = await getJson(app, "/audits?project=web&audit=test");

    expect(two.status).toBe(200);
    expect(two.body.runs.map((run: AuditRun) => run.id)).toEqual([audits[2]?.id, audits[1]?.id]);
    expect(all.body.runs).toHaveLength(3);
  });

  test("SC7303: the trend route gives one repo's metrics per audit run, oldest first, inside the period", async () => {
    const { storage, audits } = await threeWeeks();
    const app = createApi(buildDeps(storage));
    const from = weekEnding(15).periodStart;
    const to = weekEnding(22).periodEnd;

    const reply = await getJson(
      app,
      `/audits/metrics?project=web&audit=test&repo=web&from=${from}&to=${to}`,
    );

    expect(reply.status).toBe(200);
    expect(reply.body.points).toEqual([
      {
        auditRunId: audits[1]?.id,
        periodEnd: weekEnding(15).periodEnd,
        metrics: [coverage("web", 15)],
      },
      {
        auditRunId: audits[2]?.id,
        periodEnd: weekEnding(22).periodEnd,
        metrics: [coverage("web", 22)],
      },
    ]);
  });

  test("SC7304: the detail route returns the run with its times, merged limits, metrics and results", async () => {
    const storage = memoryStorage();
    await addProject(storage, "web");
    const times = {
      startedAt: "2026-11-08T09:00:00.000Z",
      completedAt: "2026-11-08T09:30:00.000Z",
    };
    await addRun(storage, "r-audit", { inputs: { coverageLimit: 70 }, state: times });
    await addRun(storage, "r-apply", { workflow: "test-audit-apply" });
    const audit = await addAudit(storage, {
      runId: "r-audit",
      slugs: ["a", "b"],
      values: { web: 75 },
    });
    const [a, b] = [`${audit.id}:web:duplicates:a`, `${audit.id}:web:duplicates:b`];
    await storage.audits.addEvent({
      resultId: b,
      who: "ana",
      type: "accepted",
      payload: {},
      startedRunId: null,
    });
    await storage.audits.addEvent({
      resultId: b,
      who: "yok",
      type: "apply_started",
      payload: {},
      startedRunId: "r-apply",
    });
    const app = createApi(buildDeps(storage));

    const { status, body } = await getJson(app, `/audits/${audit.id}`);

    expect(status).toBe(200);
    expect(body.run).toMatchObject({
      id: audit.id,
      startedAt: times.startedAt,
      endedAt: times.completedAt,
    });
    expect(body.limits.coverage).toEqual({ unit: "percent", better: "higher", limit: 70 });
    expect(body.limits.testTime.limit).toBe(240);
    expect(body.metrics).toEqual([coverage("web", 75)]);
    const byId = new Map(body.results.map((entry: { id: string }) => [entry.id, entry]));
    expect(byId.get(a)).toMatchObject({ decision: null, applyRun: null });
    expect(byId.get(b)).toMatchObject({
      decision: { type: "accepted", who: "ana" },
      applyRun: { id: "r-apply", status: "running" },
    });
  });

  test("SC7305: a limit input that is not a number is ignored", async () => {
    const storage = memoryStorage();
    await addProject(storage, "web");
    await addRun(storage, "r-1", { inputs: { coverageLimit: "75" } });
    const audit = await addAudit(storage, { runId: "r-1" });
    const app = createApi(buildDeps(storage));

    const { body } = await getJson(app, `/audits/${audit.id}`);

    expect(body.limits.coverage.limit).toBe(80);
  });

  test("SC7306: an unknown audit run id is a 404", async () => {
    const app = createApi(buildDeps());

    const reply = await getJson(app, "/audits/a-nope");

    expect(reply.status).toBe(404);
    expect(reply.body.error.code).toBe("not-found");
  });

  test.each([
    "/audits/projects?audit=nope",
    "/audits?project=web&audit=test&limit=0",
    "/audits/metrics?project=web&audit=test",
  ])("SC7307: a bad query string is refused at the door: %s", async (path) => {
    const app = createApi(buildDeps());

    const reply = await getJson(app, path);

    expect(reply.status).toBe(400);
    expect(reply.body.error.code).toBe("bad-request");
  });
});
