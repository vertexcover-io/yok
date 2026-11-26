import type { ILogger, IStorage, JsonObject, WorkflowRun } from "@yok/sdk";
import {
  type AuditPendingWork,
  type AuditResult,
  type AuditResultEvent,
  isRunLive,
  TEST_AUDIT_METRIC_NAMES,
  TEST_AUDIT_METRICS,
} from "@yok/sdk/internal";
import { type Context, Hono } from "hono";
import { errorResponse, jsonBody, queryParams, type Vars } from "./api.ts";
import { isRunGoing, readStateOrNull } from "./delivery.ts";
import { oauthApp, sessionUser } from "./identity.ts";
import {
  type AuditEventBody,
  AuditEventBodySchema,
  AuditMetricsQuerySchema,
  AuditProjectsQuerySchema,
  AuditRunsQuerySchema,
} from "./protocol.ts";
import { type GitDeps, type RunDeps, startProjectRun } from "./run.ts";

export type AuditRouteDeps = RunDeps & Readonly<{ now: () => Date }>;
// What the trigger tick passes: TriggerDeps, named here so this file never imports trigger.ts.
export type AuditTickDeps = AuditRouteDeps & GitDeps & Readonly<{ log: ILogger }>;

// The workflow that applies an accepted fix or reverts an undone one; PR 4 ships it.
const APPLY_WORKFLOW = "test-audit-apply";

// The run behind the result's newest apply_started or revert_started, while it is still stored.
export const findApplyRun = async (
  resultId: string,
  storage: IStorage,
): Promise<WorkflowRun | undefined> => {
  const started = await storage.audits.run(resultId);
  if (!started?.startedRunId) return undefined;
  return storage.runs.findRun(started.startedRunId);
};

const describeApplyRun = async (resultId: string, storage: IStorage) => {
  const run = await findApplyRun(resultId, storage);
  if (run === undefined) return null;
  const state = await readStateOrNull(storage, run.id);
  return { id: run.id, status: state?.status ?? "starting" };
};

// A project sets its own limit with a workflow input named after the metric, such as coverageLimit.
const mergeLimits = (inputs: JsonObject) =>
  Object.fromEntries(
    TEST_AUDIT_METRIC_NAMES.map((metric) => {
      const own = inputs[`${metric}Limit`];
      const info = TEST_AUDIT_METRICS[metric];
      return [metric, { ...info, limit: typeof own === "number" ? own : info.limit }];
    }),
  );

const readAudit = async (auditRunId: string, storage: IStorage) => {
  const record = await storage.audits.read(auditRunId);
  if (record === undefined) return undefined;
  const run = await storage.runs.findRun(record.run.runId);
  const state = await readStateOrNull(storage, record.run.runId);
  const results = await Promise.all(
    record.results.map(async (result) => ({
      ...result,
      decision: (await storage.audits.decision(result.id)) ?? null,
      applyRun: await describeApplyRun(result.id, storage),
    })),
  );
  return {
    run: {
      ...record.run,
      startedAt: state?.startedAt ?? null,
      endedAt: state?.completedAt ?? null,
    },
    limits: mergeLimits(run?.inputs ?? {}),
    metrics: record.metrics,
    results,
  };
};

// A named run whose agent died while its state says running still holds its results, so a resume
// can finish it; an unnamed one is going only while isRunGoing says so.
const isApplyRunGoing = async (run: WorkflowRun, deps: AuditRouteDeps): Promise<boolean> => {
  const state = await readStateOrNull(deps.storage, run.id);
  if (state !== null) return isRunLive(state.status);
  return isRunGoing(run, run.createdAt, deps);
};

// The signed-in person's GitHub login, else their yok user id. "local" on a server with no
// GitHub sign-in set up; null when sign-in is set up and nobody is signed in.
const findDecider = async (
  c: Context<{ Variables: Vars }>,
  deps: AuditRouteDeps,
): Promise<string | null> => {
  const signedIn = await sessionUser(c, { ...deps, log: c.get("log") });
  if (signedIn !== null) return signedIn[1].accounts.github?.login ?? signedIn[0];
  return oauthApp(deps.home) === null ? "local" : null;
};

const recordClick = async (
  c: Context<{ Variables: Vars }>,
  deps: AuditRouteDeps,
  resultId: string,
  { type, feedback }: AuditEventBody,
) => {
  const who = await findDecider(c, deps);
  if (who === null) return errorResponse(c, 401, "unauthorized", "sign in to decide");
  // a result id opens with its audit run's id: AUDIT_RUN_ID:repo:problemType:slug
  const [auditRunId = ""] = resultId.split(":");
  const record = await deps.storage.audits.read(auditRunId);
  if (record?.results.some((result) => result.id === resultId) !== true) {
    return errorResponse(c, 404, "not-found", `no audit result with id ${resultId}`);
  }
  const applyRun = type === "rejected" ? undefined : await findApplyRun(resultId, deps.storage);
  if (applyRun !== undefined && (await isApplyRunGoing(applyRun, deps))) {
    return errorResponse(
      c,
      409,
      "conflict",
      `apply run ${applyRun.name ?? applyRun.id} is still working on this result; try again when it ends`,
    );
  }
  const event = await deps.storage.audits.addEvent({
    resultId,
    type,
    who,
    startedRunId: null,
    payload: feedback === undefined ? {} : { feedback },
  });
  return c.json({ event }, 201);
};

const isApplyRunGoingIn = async (project: string, deps: AuditTickDeps): Promise<boolean> => {
  const runs = (await deps.storage.runs.listRuns()).filter(
    (run) => run.project === project && run.workflow === APPLY_WORKFLOW,
  );
  const going = await Promise.all(runs.map((run) => isApplyRunGoing(run, deps)));
  return going.includes(true);
};

const startApplyRun = async (
  project: string,
  work: readonly AuditPendingWork[],
  deps: AuditTickDeps,
): Promise<void> => {
  const launched = await startProjectRun(
    {
      project,
      workflow: APPLY_WORKFLOW,
      inputs: { results: work.map(({ result, action }) => ({ id: result.id, action })) },
      // `orchestrate init` refuses a run folder that exists, so every apply run gets a new name
      name: `${APPLY_WORKFLOW}-${deps.now().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-")}`,
      // nobody is attached to answer a question
      policies: { interaction: false },
    },
    deps,
    deps.log,
    { source: "trigger" },
  ).catch((error: unknown) => ({
    ok: false as const,
    error: { message: error instanceof Error ? error.message : String(error) },
  }));
  if (!launched.ok) {
    deps.log.info({ project, err: launched.error.message }, "audit apply run not started");
    for (const { result } of work) {
      await deps.storage.audits.setFix(result.id, {
        error: `could not start apply run: ${launched.error.message}`,
      });
    }
    return;
  }
  const runId = launched.value.run.id;
  for (const { result, action } of work) {
    await deps.storage.audits.addEvent({
      resultId: result.id,
      type: action === "apply" ? "apply_started" : "revert_started",
      who: "yok",
      startedRunId: runId,
      payload: {},
    });
  }
  deps.log.info({ project, runId, results: work.length }, "audit apply run started");
};

// One apply run per project at a time; a click made meanwhile waits for the next one.
export const startAuditApplyRuns = async (deps: AuditTickDeps): Promise<void> => {
  for (const project of Object.keys(await deps.storage.projects.list())) {
    const work = await deps.storage.audits.pendingWork(project);
    if (work.length === 0 || (await isApplyRunGoingIn(project, deps))) continue;
    await startApplyRun(project, work, deps);
  }
};

// fix.at stamps setFix's last write; a finished revert clears it along with the commit
const isOutcomeWritten = (fix: AuditResult["fix"], started: AuditResultEvent): boolean =>
  fix === null ||
  (fix.at ?? "") >= started.ts ||
  (started.type === "revert_started" && fix.commit === undefined);

const readFix = async (resultId: string, storage: IStorage) => {
  const [auditRunId = ""] = resultId.split(":");
  const record = await storage.audits.read(auditRunId);
  return record?.results.find((entry) => entry.id === resultId)?.fix ?? null;
};

const failIfAbandoned = async (result: AuditResult, deps: AuditTickDeps): Promise<void> => {
  const started = await deps.storage.audits.run(result.id);
  if (started === undefined || isOutcomeWritten(result.fix, started)) return;
  // startedRunId turns null when the run is removed
  const runId = started.startedRunId;
  const run = runId === null ? undefined : await deps.storage.runs.findRun(runId);
  if (run !== undefined && (await isApplyRunGoing(run, deps))) return;
  // the run may have written its outcomes since the audit was read, just before it ended
  if (isOutcomeWritten(await readFix(result.id, deps.storage), started)) return;
  await deps.storage.audits.setFix(result.id, {
    error: runId === null ? "apply run failed: it was removed" : `apply run ${runId} failed`,
  });
};

// Every test audit result of every project, each tick: cheap at today's volume, and grows with
// every audit kept.
export const failAbandonedApplies = async (deps: AuditTickDeps): Promise<void> => {
  for (const project of Object.keys(await deps.storage.projects.list())) {
    for (const auditRun of await deps.storage.audits.list(project, "test")) {
      const record = await deps.storage.audits.read(auditRun.id);
      for (const result of record?.results ?? []) await failIfAbandoned(result, deps);
    }
  }
};

// Mounted at /audits by app.ts. Chained, so each route's input and output types reach ApiType.
// The fixed paths come before /:auditRunId, which would otherwise match them.
export const auditRoutes = (deps: AuditRouteDeps) =>
  new Hono<{ Variables: Vars }>()
    .get("/projects", queryParams(AuditProjectsQuerySchema), async (c) => {
      const { audit } = c.req.valid("query");
      const names = Object.keys(await deps.storage.projects.list());
      const audited = await Promise.all(
        names.map(
          async (name) => (await deps.storage.audits.list(name, audit, { limit: 1 })).length > 0,
        ),
      );
      return c.json({ projects: names.filter((_name, index) => audited[index]) }, 200);
    })
    .get("/", queryParams(AuditRunsQuerySchema), async (c) => {
      const { project, audit, limit } = c.req.valid("query");
      return c.json({ runs: await deps.storage.audits.list(project, audit, { limit }) }, 200);
    })
    .get("/metrics", queryParams(AuditMetricsQuerySchema), async (c) => {
      const { project, audit, repo, from, to } = c.req.valid("query");
      const runs = await deps.storage.audits.list(project, audit, {
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to }),
      });
      // list gives the newest period first; the charts draw oldest first
      const points = await Promise.all(
        [...runs].reverse().map(async (run) => ({
          auditRunId: run.id,
          periodEnd: run.periodEnd,
          metrics: ((await deps.storage.audits.read(run.id))?.metrics ?? []).filter(
            (metric) => metric.repo === repo,
          ),
        })),
      );
      return c.json({ points }, 200);
    })
    .get("/:auditRunId", async (c) => {
      const auditRunId = c.req.param("auditRunId");
      const audit = await readAudit(auditRunId, deps.storage);
      if (audit === undefined) {
        return errorResponse(c, 404, "not-found", `no audit run with id ${auditRunId}`);
      }
      return c.json(audit, 200);
    })
    // The page URL-encodes resultId, which holds colons; Hono decodes the param.
    .post("/results/:resultId/events", jsonBody(AuditEventBodySchema), (c) =>
      recordClick(c, deps, c.req.param("resultId"), c.req.valid("json")),
    );
