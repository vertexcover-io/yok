import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IStorage, JsonObject, LaunchOptions, State } from "@yok/sdk";
import { createGit, noopLogger } from "@yok/sdk";
import { type AuditResult, type AuditRun, memoryStorage } from "@yok/sdk/internal";
import { createApi } from "./app.ts";
import { fakeHost, fakePane, fakeProvider, seedState, seedUser } from "./fake-host.ts";
import { sessionSecret, signValue } from "./identity.ts";
import { updateHomeEnv } from "./protocol.ts";
import { checkCheckoutWith } from "./server.ts";
import { type TriggerDeps, tick } from "./trigger.ts";

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
  unnamed?: boolean;
}>;

// Stores run ID in PROJECT, named by init with a state as a started run is, unless UNNAMED.
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
  if (seed.unnamed === true) return;
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
    await addRun(storage, "r-apply", { workflow: "test-audit-apply", terminal: "t-apply" });
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
    const app = createApi(buildDeps(storage, true));

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
    "/audits?project=web&audit=test&limit=101",
    `/audits?project=web&audit=test&limit=${"9".repeat(400)}`,
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

// Result A's newest apply_started names run r-apply, with STATUS and an agent session that is
// open when ALIVE.
const applying = async (status: State["status"], alive = true) => {
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
  return { ...env, app: createApi(buildDeps(env.storage, alive)) };
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
    ["rejected", 409],
  ])("SC7311: while the result's apply run is going, %s answers %d", async (type, status) => {
    const { app, resultId } = await applying("running");

    const response = await click(app, resultId, { type });

    expect(response.status).toBe(status);
    if (status === 409) expect((await response.json()).error.code).toBe("conflict");
  });

  test("SC7311: Accept answers 409 while the apply run is a minute old and not yet named", async () => {
    const { storage, resultId } = await oneResult();
    await addRun(storage, "r-apply", {
      workflow: "test-audit-apply",
      terminal: "t-apply",
      unnamed: true,
    });
    await storage.audits.addEvent({
      resultId,
      who: "yok",
      type: "apply_started",
      payload: {},
      startedRunId: "r-apply",
    });
    const minuteLater = () => new Date(new Date(AT).getTime() + 60_000);
    const app = createApi({ ...buildDeps(storage, true), now: minuteLater });

    const response = await click(app, resultId, { type: "accepted" });

    expect(response.status).toBe(409);
  });

  test("Accept answers 409 while the apply run's agent is dead and its state says running", async () => {
    const { app, resultId } = await applying("running", false);

    const response = await click(app, resultId, { type: "accepted" });

    expect(response.status).toBe(409);
  });

  test("an apply run whose agent is dead while its state says running reads as gone, and Accept still answers 409", async () => {
    const { app, audit, resultId } = await applying("running", false);

    const { body } = await getJson(app, `/audits/${audit.id}`);
    const response = await click(app, resultId, { type: "accepted" });

    expect(body.results[0]).toMatchObject({
      id: resultId,
      applyRun: { id: "r-apply", status: "gone" },
    });
    expect(response.status).toBe(409);
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

const APPLY_WORKFLOW = [
  "name: test-audit-apply",
  "inputs:",
  "  results: { type: array, required: true }",
  "nodes:",
  "  - id: a",
  "    type: exec",
  "    runtime: sh",
  '    script: "true"',
  "    input: null",
  "",
].join("\n");

// A git checkout with a workflows folder, holding test-audit-apply.yaml when WITH_WORKFLOW.
const makeRepo = (withWorkflow: boolean): string => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "yok-audit-repo-")));
  execFileSync("git", ["init", "-q"], { cwd });
  writeFileSync(join(cwd, ".gitignore"), ".yok/\n");
  writeFileSync(
    join(cwd, "orchestrate.config.json"),
    '{ "version": 2, "workflowPath": "workflows" }',
  );
  mkdirSync(join(cwd, "workflows"));
  if (withWorkflow) writeFileSync(join(cwd, "workflows", "test-audit-apply.yaml"), APPLY_WORKFLOW);
  return cwd;
};

const TICK_AT = "2026-11-26T10:00:10.000Z";

// A server's view for the tick: each project a checkout of its own, and a provider that records
// each launch instead of starting an agent.
const tickSetup = async (projects: readonly string[] = ["web"], withWorkflow = true) => {
  const storage = memoryStorage();
  const home = mkdtempSync(join(tmpdir(), "yok-audit-home-"));
  for (const name of projects) {
    const added = await storage.projects.add(name, {
      path: makeRepo(withWorkflow),
      addedBy: { channel: "cli" },
      addedAt: AT,
    });
    if (!added.ok) throw new Error(added.error);
  }
  const launches: LaunchOptions[] = [];
  const deps = (alive = true, now = TICK_AT): TriggerDeps => ({
    storage,
    providerFor: (agent) =>
      fakeProvider(agent, (options) => {
        launches.push(options);
        return Promise.resolve({
          ok: true,
          value: { terminalName: "s1", terminal: fakePane("s1") },
        });
      }),
    host: fakeHost("", alive).host,
    home,
    publicOrigin: "http://localhost:1",
    git: createGit(),
    checkCheckout: (input) => checkCheckoutWith([], input),
    log: noopLogger,
    now: () => new Date(now),
  });
  return { storage, launches, deps };
};

const clickAs = (storage: IStorage, resultId: string, type: "accepted" | "undone") =>
  storage.audits.addEvent({ resultId, who: "ana", type, payload: {}, startedRunId: null });

const fixOf = async (storage: IStorage, resultId: string) => {
  const [auditRunId = ""] = resultId.split(":");
  const record = await storage.audits.read(auditRunId);
  return record?.results.find((entry) => entry.id === resultId)?.fix;
};

// One audit of PROJECT holding results for SLUGS; returns their ids in order.
const auditWith = async (storage: IStorage, project: string, slugs: readonly string[]) => {
  await addRun(storage, `r-audit-${project}`, { project });
  const audit = await addAudit(storage, { runId: `r-audit-${project}`, project, slugs });
  return slugs.map((slug) => `${audit.id}:web:duplicates:${slug}`);
};

// Sets the stored state of run RUN_ID to STATUS, naming it as orchestrate init does.
const setState = async (storage: IStorage, runId: string, status: State["status"]) => {
  await storage.runs.releaseRun(runId);
  const state = { ...seedState(`/abs/.yok/${runId}`, {}), runId, status };
  const named = await storage.runs.initRun(runId, `apply-${runId}`, state);
  if (!named.ok) throw new Error(named.error);
};

// Project web with result A accepted and result B undone after a commit, then one tick.
const appliedOnce = async () => {
  const env = await tickSetup();
  const [a = "", b = ""] = await auditWith(env.storage, "web", ["a", "b"]);
  await clickAs(env.storage, b, "accepted");
  await env.storage.audits.setFix(b, { commit: "abc" });
  await clickAs(env.storage, a, "accepted");
  await clickAs(env.storage, b, "undone");
  await tick(env.deps());
  const runId = (await env.storage.audits.run(a))?.startedRunId ?? "";
  return { ...env, a, b, runId };
};

const TIMEOUT_MS = 20_000;

describe("the tick's audit apply runs", () => {
  test(
    "SC7315: a tick starts one apply run for a project's accepted and undone results",
    async () => {
      const { storage, launches, a, b, runId } = await appliedOnce();

      expect(launches).toHaveLength(1);
      expect(launches[0]?.prompt).toEndWith(
        `--inputs {"results":[{"id":"${a}","action":"apply"},{"id":"${b}","action":"revert"}]} --name test-audit-apply-20261126-100010`,
      );
      expect(runId).toMatch(/^r-/);
      expect(await storage.audits.run(a)).toMatchObject({
        type: "apply_started",
        who: "yok",
        startedRunId: runId,
      });
      expect(await storage.audits.run(b)).toMatchObject({
        type: "revert_started",
        who: "yok",
        startedRunId: runId,
      });
      expect(await storage.audits.pendingWork("web")).toEqual([]);
    },
    TIMEOUT_MS,
  );

  test(
    "SC7316: a tick while the apply run is going starts nothing, and the next click waits for it to end",
    async () => {
      const { storage, launches, deps, a, b, runId } = await appliedOnce();
      await addRun(storage, "r-audit-2");
      const later = await addAudit(storage, { runId: "r-audit-2", day: 15, slugs: ["c"] });
      const c = `${later.id}:web:duplicates:c`;
      await clickAs(storage, c, "accepted");

      // the apply run is not named yet: orchestrate init has not run
      await tick(deps());
      expect(launches).toHaveLength(1);

      await setState(storage, runId, "running");
      await tick(deps());
      expect(launches).toHaveLength(1);
      expect(await storage.audits.pendingWork("web")).toHaveLength(1);

      await storage.audits.setFix(a, { commit: "c1" });
      await storage.audits.setFix(b, { clear: true });
      await setState(storage, runId, "completed");
      await tick(deps());

      expect(launches).toHaveLength(2);
      expect(launches[1]?.prompt).toContain(
        `--inputs {"results":[{"id":"${c}","action":"apply"}]}`,
      );
    },
    TIMEOUT_MS,
  );

  test(
    "SC7317: two projects with pending work each get their own apply run",
    async () => {
      const { storage, launches, deps } = await tickSetup(["web", "api"]);
      const [web = ""] = await auditWith(storage, "web", ["a"]);
      const [api = ""] = await auditWith(storage, "api", ["a"]);
      await clickAs(storage, web, "accepted");
      await clickAs(storage, api, "accepted");

      await tick(deps());

      expect(launches).toHaveLength(2);
      const webRun = await storage.runs.findRun(
        (await storage.audits.run(web))?.startedRunId ?? "",
      );
      const apiRun = await storage.runs.findRun(
        (await storage.audits.run(api))?.startedRunId ?? "",
      );
      expect(webRun?.project).toBe("web");
      expect(apiRun?.project).toBe("api");
    },
    TIMEOUT_MS,
  );

  test(
    "SC7318: a refused start writes the reason on each pending result and is not retried",
    async () => {
      const { storage, launches, deps } = await tickSetup(["web"], false);
      const [a = ""] = await auditWith(storage, "web", ["a"]);
      await clickAs(storage, a, "accepted");

      await tick(deps());
      const error = (await fixOf(storage, a))?.error;
      await tick(deps());

      expect(launches).toHaveLength(0);
      expect(await storage.audits.run(a)).toBeUndefined();
      expect(error).toStartWith("could not start apply run: ");
      expect((await fixOf(storage, a))?.error).toBe(error);
    },
    TIMEOUT_MS,
  );

  test.each(["failed", "completed", "cancelled"] as const)(
    "SC7319: an apply run that ended %s without writing its results' outcomes marks them failed",
    async (status) => {
      const { storage, launches, deps, a, b, runId } = await appliedOnce();
      await setState(storage, runId, status);

      await tick(deps());

      expect((await fixOf(storage, a))?.error).toBe(`apply run ${runId} failed`);
      expect(await fixOf(storage, b)).toMatchObject({
        error: `apply run ${runId} failed`,
        commit: "abc",
      });
      expect(launches).toHaveLength(1);
    },
    TIMEOUT_MS,
  );

  test(
    "SC7320: outcomes the apply run did write are left alone",
    async () => {
      const { storage, deps, a, b, runId } = await appliedOnce();
      await storage.audits.setFix(a, { commit: "c1", pr: "7" });
      await storage.audits.setFix(b, { clear: true });
      await setState(storage, runId, "completed");

      await tick(deps());

      const fixA = await fixOf(storage, a);
      expect(fixA).toMatchObject({ commit: "c1", pr: "7" });
      expect(fixA?.error).toBeUndefined();
      const fixB = await fixOf(storage, b);
      expect(fixB?.commit).toBeUndefined();
      expect(fixB?.error).toBeUndefined();
    },
    TIMEOUT_MS,
  );

  test(
    "outcomes the apply run writes after the sweep read the audit, before it read the run, are left alone",
    async () => {
      const { storage, deps, a, b, runId } = await appliedOnce();
      await setState(storage, runId, "completed");
      // the run writes its outcomes while the sweep is between its audit read and its first run read
      let written = false;
      const findRun = async (id: string) => {
        if (!written) {
          written = true;
          await storage.audits.setFix(a, { commit: "c1" });
          await storage.audits.setFix(b, { clear: true });
        }
        return storage.runs.findRun(id);
      };

      await tick({ ...deps(), storage: { ...storage, runs: { ...storage.runs, findRun } } });

      expect(await fixOf(storage, a)).toMatchObject({ commit: "c1" });
      expect((await fixOf(storage, a))?.error).toBeUndefined();
      expect((await fixOf(storage, b))?.error).toBeUndefined();
    },
    TIMEOUT_MS,
  );

  test(
    "SC7321: an apply run whose agent died while its state says running is left alone, and no second one starts",
    async () => {
      const { storage, launches, deps, a, b, runId } = await appliedOnce();
      await setState(storage, runId, "running");
      await clickAs(storage, a, "accepted");

      await tick(deps(false));

      expect((await fixOf(storage, a))?.error).toBeUndefined();
      expect((await fixOf(storage, b))?.error).toBeUndefined();
      expect(launches).toHaveLength(1);
    },
    TIMEOUT_MS,
  );

  test(
    "an apply run whose agent died before orchestrate init named it marks its results failed",
    async () => {
      const { storage, launches, deps, a, b, runId } = await appliedOnce();

      await tick(deps(false));

      expect((await fixOf(storage, a))?.error).toBe(`apply run ${runId} failed`);
      expect((await fixOf(storage, b))?.error).toBe(`apply run ${runId} failed`);
      expect(launches).toHaveLength(1);
    },
    TIMEOUT_MS,
  );

  test(
    "an Undo then Accept made after the apply run started is not marked failed when the run ends, and the next run applies it",
    async () => {
      const { storage, launches, deps, a, runId } = await appliedOnce();
      // event times are milliseconds, and a click in the start's millisecond counts as before it
      await Bun.sleep(2);
      await clickAs(storage, a, "undone");
      await clickAs(storage, a, "accepted");
      await setState(storage, runId, "failed");

      await tick(deps());

      expect((await fixOf(storage, a))?.error).toBeUndefined();
      expect(launches).toHaveLength(2);
      expect(launches[1]?.prompt).toContain(`{"id":"${a}","action":"apply"}`);
    },
    TIMEOUT_MS,
  );

  test(
    "SC7322: a result whose apply run was removed is marked failed",
    async () => {
      const { storage, deps, a, runId } = await appliedOnce();
      await storage.runs.removeRun(runId);

      await tick(deps());

      expect((await fixOf(storage, a))?.error).toBe("apply run failed: it was removed");
    },
    TIMEOUT_MS,
  );
});
