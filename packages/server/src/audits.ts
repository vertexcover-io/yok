import type { IStorage, JsonObject, WorkflowRun } from "@yok/sdk";
import { TEST_AUDIT_METRIC_NAMES, TEST_AUDIT_METRICS } from "@yok/sdk/internal";
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
import type { RunDeps } from "./run.ts";

export type AuditRouteDeps = RunDeps & Readonly<{ now: () => Date }>;

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
  if (applyRun !== undefined && (await isRunGoing(applyRun, applyRun.createdAt, deps))) {
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
