import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IStorage, JsonObject, State } from "@yok/sdk";
import { createGit, noopLogger } from "@yok/sdk";
import { type AuditResult, type AuditRun, memoryStorage } from "@yok/sdk/internal";
import { createApi } from "./app.ts";
import { fakeHost, fakeProvider, seedState, seedUser } from "./fake-host.ts";
import { sessionSecret, signValue } from "./identity.ts";
import { updateHomeEnv } from "./protocol.ts";

const AT = "2026-11-01T00:00:00.000Z";

// ALIVE: whether every run's agent session is still open
const buildDeps = (storage: IStorage = memoryStorage(), alive = false) => ({
  storage,
  providerFor: () => fakeProvider("claude", () => Promise.resolve({ ok: false, error: "unused" })),
  host: fakeHost("", alive).host,
  now: () => new Date(),
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
  terminal?: string;
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
    terminal: seed.terminal ?? null,
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

// Project web with one audit holding result A, which has a fix.
const oneResult = async (storage: IStorage = memoryStorage()) => {
  await addProject(storage, "web");
  await addRun(storage, "r-audit");
  const audit = await addAudit(storage, { runId: "r-audit", slugs: ["a"] });
  return { storage, audit, resultId: `${audit.id}:web:duplicates:a` };
};

const setUpSignIn = (home: string) =>
  updateHomeEnv(home, { GITHUB_CLIENT_ID: "x", GITHUB_CLIENT_SECRET: "y" });

const sessionCookie = async (home: string, userId: string): Promise<string> => {
  const exp = Date.now() + 60 * 60 * 1000;
  const value = signValue(await sessionSecret(home), { sub: userId, purpose: "session", exp });
  return `yok_session=${value}`;
};

const click = (
  app: ReturnType<typeof createApi>,
  resultId: string,
  body: unknown,
  cookie?: string,
) =>
  app.request(`/audits/results/${encodeURIComponent(resultId)}/events`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie === undefined ? {} : { cookie }) },
    body: JSON.stringify(body),
  });

// Result A's newest apply_started names run r-apply, with an open agent session and STATUS.
const applying = async (status: State["status"]) => {
  const env = await oneResult();
  await addRun(env.storage, "r-apply", {
    workflow: "test-audit-apply",
    terminal: "t-apply",
    state: { status },
  });
  await env.storage.audits.addEvent({
    resultId: env.resultId,
    who: "yok",
    type: "apply_started",
    payload: {},
    startedRunId: "r-apply",
  });
  return { ...env, app: createApi(buildDeps(env.storage, true)) };
};

describe("POST /audits/results/:resultId/events", () => {
  test("SC7308: a signed-in person's Accept is saved under their GitHub login", async () => {
    const { storage, audit, resultId } = await oneResult();
    const deps = buildDeps(storage);
    await setUpSignIn(deps.home);
    const userId = await seedUser(storage, { name: "Octo", github: { id: 7, login: "octo" } });
    const app = createApi(deps);

    const response = await click(
      app,
      resultId,
      { type: "accepted" },
      await sessionCookie(deps.home, userId),
    );

    expect(response.status).toBe(201);
    expect((await response.json()).event).toMatchObject({
      resultId,
      type: "accepted",
      who: "octo",
      startedRunId: null,
      payload: {},
    });
    const { body } = await getJson(app, `/audits/${audit.id}`);
    expect(body.results[0].decision.who).toBe("octo");
    expect(await storage.runs.listRuns()).toHaveLength(1);
  });

  test("SC7309: on a server with no sign-in set up, a Reject with feedback is saved as local", async () => {
    const { storage, resultId } = await oneResult();
    const app = createApi(buildDeps(storage));

    const response = await click(app, resultId, { type: "rejected", feedback: "keep it" });

    expect(response.status).toBe(201);
    expect((await response.json()).event).toMatchObject({
      who: "local",
      payload: { feedback: "keep it" },
    });
  });

  test("SC7310: with sign-in set up, a click without a session is refused and nothing is stored", async () => {
    const { storage, resultId } = await oneResult();
    const deps = buildDeps(storage);
    await setUpSignIn(deps.home);

    const response = await click(createApi(deps), resultId, { type: "accepted" });

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("unauthorized");
    expect(await storage.audits.decision(resultId)).toBeUndefined();
  });

  test.each([
    ["accepted", 409],
    ["undone", 409],
    ["rejected", 201],
  ])("SC7311: while the result's apply run is going, %s answers %d", async (type, status) => {
    const { app, resultId } = await applying("running");

    const response = await click(app, resultId, { type });

    expect(response.status).toBe(status);
    if (status === 409) expect((await response.json()).error.code).toBe("conflict");
  });

  test("SC7312: Accept is taken once the result's apply run has ended", async () => {
    const { app, resultId } = await applying("failed");

    const response = await click(app, resultId, { type: "accepted" });

    expect(response.status).toBe(201);
  });

  test("SC7313: a click on an unknown result is a 404", async () => {
    const { storage, audit } = await oneResult();

    const response = await click(createApi(buildDeps(storage)), `${audit.id}:web:flaky:nope`, {
      type: "accepted",
    });

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not-found");
  });

  test.each([[{ type: "applied" }], [{ type: "accepted", who: "mallory" }]])(
    "SC7313: a bad or forged click body is a 400: %o",
    async (body) => {
      const { storage, resultId } = await oneResult();

      const response = await click(createApi(buildDeps(storage)), resultId, body);

      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("bad-request");
    },
  );
});
